import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { GitPublisher } from "../src/publish/git-publisher.js";
import type {
  GitCommandResult,
  GitCommandRunner,
  GitPublishReceipt,
  GitPublishRequest,
  VerifiedChangeSet,
} from "../src/publish/contracts.js";
import {
  attestRevisionGitBoundary,
  calculateApprovedRevisionSnapshot,
  publishRevision,
} from "../src/revision/revision-git.js";
import { DraftPullRequestStateMachine, type ExecuteDraftPrInput } from "../src/pull-request/draft-pr-service.js";
import type {
  DraftPullRequestReceipt,
  GitHubPullRequest,
  GitHubPullRequestClient,
} from "../src/pull-request/contracts.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function inspectChangeSet(
  runner: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
): Promise<VerifiedChangeSet> {
  const digest = createHash("sha256");
  for (const relativePath of [...paths].sort()) {
    digest.update(relativePath);
    digest.update("\u0000");
    digest.update(await fs.readFile(path.join(cwd, relativePath)));
    digest.update("\u0000");
  }
  const status = await runner.run(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  assert.equal(status.exitCode, 0, status.stderr);
  digest.update(status.stdout.trim());
  return { change_set_sha256: digest.digest("hex"), paths: [...paths] };
}

class CountingGitRunner extends GitRunner {
  public realPushes = 0;

  override async run(args: readonly string[], cwd: string): Promise<Awaited<ReturnType<GitRunner["run"]>>> {
    if (args[0] === "push" && !args.includes("--dry-run")) this.realPushes += 1;
    return super.run(args, cwd);
  }
}

class CrashAfterSuccessfulPushRunner extends GitRunner {
  public realPushes = 0;
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  override async run(args: readonly string[], cwd: string): Promise<Awaited<ReturnType<GitRunner["run"]>>> {
    const isPush = args[0] === "push" && !args.includes("--dry-run");
    const result = await super.run(args, cwd);
    if (isPush) {
      this.realPushes += 1;
      if (this.armed && result.exitCode === 0) {
        this.armed = false;
        throw new Error("simulated hard crash after successful revision push");
      }
    }
    return result;
  }
}

test("SIDE-EFFECT-REC-001 initial publish restart adopts an already-pushed remote without a duplicate push", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-initial-push-crash-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(remote);
  await fs.mkdir(repo);

  const setup = new GitRunner();
  await git(setup, remote, ["init", "--bare"]);
  await git(setup, repo, ["init"]);
  await git(setup, repo, ["config", "user.name", "WCO Crash Recovery"]);
  await git(setup, repo, ["config", "user.email", "wco-crash-recovery@example.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf8");
  await git(setup, repo, ["add", "README.md"]);
  await git(setup, repo, ["commit", "-m", "base"]);
  const baseCommit = await git(setup, repo, ["rev-parse", "HEAD"]);
  const branchName = "codex/side-effect-recovery";
  await git(setup, repo, ["switch", "-c", branchName]);
  await git(setup, repo, ["remote", "add", "origin", remote]);
  await fs.writeFile(path.join(repo, "feature.txt"), "verified\n", "utf8");

  const firstRunner = new CountingGitRunner();
  const changeSet = await inspectChangeSet(firstRunner, repo, ["feature.txt"]);
  const request: GitPublishRequest = {
    run_id: "SIDE-EFFECT-REC-001",
    worktree_path: repo,
    base_commit: baseCommit,
    branch_name: branchName,
    remote_name: "origin",
    allowed_remote_url: remote,
    allowed_branch_prefix: "codex/",
    deny_direct_push_branches: ["main", "master"],
    expected_change_set_sha256: changeSet.change_set_sha256,
    expected_paths: changeSet.paths,
    commit_message: "publish crash recovery fixture",
    allow_force_push: false,
    allow_remote_branch_delete: false,
  };

  let durable: GitPublishReceipt | null = null;
  const firstPublisher = new GitPublisher({
    runner: firstRunner,
    inspectVerifiedChangeSet: () => inspectChangeSet(firstRunner, repo, ["feature.txt"]),
    persistReceipt: async (receipt) => {
      if (receipt.state === "PUSHED") throw new Error("simulated hard crash before PUSHED receipt durability");
      durable = structuredClone(receipt);
    },
  });

  await assert.rejects(() => firstPublisher.publish(request), /simulated hard crash/);
  assert.equal(firstRunner.realPushes, 1, "the first process must have completed exactly one real push");
  assert.ok(durable);
  assert.equal((durable as GitPublishReceipt).state, "COMMITTED");
  const commitSha = (durable as GitPublishReceipt).commit_sha;
  assert.ok(commitSha);
  const remoteAfterCrash = await git(setup, repo, ["ls-remote", "--heads", "origin", `refs/heads/${branchName}`]);
  assert.equal(remoteAfterCrash.split(/\s+/)[0], commitSha);

  const restartRunner = new CountingGitRunner();
  const restartedPublisher = new GitPublisher({
    runner: restartRunner,
    inspectVerifiedChangeSet: async () => {
      throw new Error("COMMITTED crash recovery must not re-inspect a clean worktree");
    },
    persistReceipt: async (receipt) => { durable = structuredClone(receipt); },
  });
  const recovered = await restartedPublisher.publish(request, structuredClone(durable as GitPublishReceipt));

  assert.equal(recovered.state, "PUSHED");
  assert.equal(recovered.remote_branch_sha, commitSha);
  assert.equal(restartRunner.realPushes, 0, "restart must adopt the exact remote SHA instead of pushing again");
});

test("SIDE-EFFECT-REC-002 revision restart adopts a push that succeeded immediately before process death", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-revision-push-crash-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(remote);
  await fs.mkdir(repo);

  const setup = new GitRunner();
  await git(setup, remote, ["init", "--bare"]);
  await git(setup, repo, ["init"]);
  await git(setup, repo, ["config", "user.name", "WCO Revision Recovery"]);
  await git(setup, repo, ["config", "user.email", "wco-revision-recovery@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "before\n", "utf8");
  await git(setup, repo, ["add", "app.txt"]);
  await git(setup, repo, ["commit", "-m", "initial"]);
  await git(setup, repo, ["branch", "-M", "codex/revision-recovery"]);
  await git(setup, repo, ["remote", "add", "origin", remote]);
  await git(setup, repo, ["push", "-u", "origin", "codex/revision-recovery"]);
  const previous = await git(setup, repo, ["rev-parse", "HEAD"]);

  const crashRunner = new CrashAfterSuccessfulPushRunner();
  const boundary = await attestRevisionGitBoundary({
    worktreePath: repo,
    branchName: "codex/revision-recovery",
    remoteName: "origin",
    expectedRemoteUrls: [remote],
    previousHeadSha: previous,
    runner: crashRunner,
  });
  await fs.writeFile(path.join(repo, "app.txt"), "after\n", "utf8");
  const approvedSnapshotSha256 = await calculateApprovedRevisionSnapshot({
    runner: crashRunner,
    worktreePath: repo,
    approvedPaths: ["app.txt"],
  });
  crashRunner.arm();

  await assert.rejects(
    () => publishRevision({
      ...boundary,
      approvedPaths: ["app.txt"],
      approvedSnapshotSha256,
      commitMessage: "wco: crash-recovery revision",
    }, crashRunner),
    /simulated hard crash after successful revision push/,
  );
  assert.equal(crashRunner.realPushes, 1);
  const crashCommit = await git(setup, repo, ["rev-parse", "HEAD"]);
  assert.notEqual(crashCommit, previous);
  const remoteAfterCrash = await git(setup, repo, ["ls-remote", "--heads", "origin", "refs/heads/codex/revision-recovery"]);
  assert.equal(remoteAfterCrash.split(/\s+/)[0], crashCommit, "the remote side effect must have happened before the injected crash");

  const restartRunner = new CountingGitRunner();
  const recovered = await publishRevision({
    ...boundary,
    approvedPaths: ["app.txt"],
    approvedSnapshotSha256,
    commitMessage: "wco: crash-recovery revision",
  }, restartRunner);

  assert.equal(recovered.new_commit_sha, crashCommit);
  assert.equal(recovered.remote_branch_sha, crashCommit);
  assert.equal(recovered.recovered_existing_commit, true);
  assert.equal(restartRunner.realPushes, 0, "restart must adopt the exact already-pushed revision without another push");
  assert.equal(await git(setup, repo, ["rev-list", "--count", `${previous}..HEAD`]), "1");
});

interface SharedDraftRemote {
  pulls: GitHubPullRequest[];
  createCalls: number;
}

function exactDraftPullRequest(): GitHubPullRequest {
  return {
    number: 77,
    html_url: "https://github.com/foo/bar/pull/77",
    state: "open",
    draft: true,
    merged_at: null,
    title: "WCO: task-1",
    body: null,
    head: {
      ref: "feature",
      sha: "0123456789012345678901234567890123456789",
      repo: { full_name: "foo/bar" },
    },
    base: {
      ref: "main",
      sha: "1111111111111111111111111111111111111111",
      repo: { full_name: "foo/bar" },
    },
  };
}

class StatefulDraftRemoteClient implements GitHubPullRequestClient {
  constructor(private readonly remote: SharedDraftRemote) {}

  async listByHead(): Promise<GitHubPullRequest[]> {
    return this.remote.pulls.map((pull) => structuredClone(pull));
  }

  async get(): Promise<GitHubPullRequest> {
    const pull = this.remote.pulls[0];
    if (!pull) throw new Error("missing remote pull request");
    return structuredClone(pull);
  }

  async createDraft(): Promise<GitHubPullRequest> {
    this.remote.createCalls += 1;
    const pull = exactDraftPullRequest();
    this.remote.pulls.push(structuredClone(pull));
    return structuredClone(pull);
  }
}

function draftInput(existingReceipt: DraftPullRequestReceipt | null): ExecuteDraftPrInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    owner: "foo",
    repository: "bar",
    baseBranch: "main",
    headBranch: "feature",
    expectedHeadSha: "0123456789012345678901234567890123456789",
    changeSetSha256: "a".repeat(64),
    gitPublishReceiptSha256: "b".repeat(64),
    existingReceipt,
    verifyRemoteHead: async () => {},
  };
}

test("SIDE-EFFECT-REC-003 Draft PR restart discovers the remotely-created PR after crash before OPEN persistence", async () => {
  const remote: SharedDraftRemote = { pulls: [], createCalls: 0 };
  let durable: DraftPullRequestReceipt | null = null;

  const firstMachine = new DraftPullRequestStateMachine(
    new StatefulDraftRemoteClient(remote),
    async (receipt) => {
      if (receipt.state === "OPEN") throw new Error("simulated hard crash before OPEN receipt durability");
      durable = structuredClone(receipt);
    },
  );

  await assert.rejects(() => firstMachine.execute(draftInput(null)), /simulated hard crash/);
  assert.equal(remote.createCalls, 1, "the remote Draft PR create side effect must happen exactly once before the crash");
  assert.equal(remote.pulls.length, 1);
  assert.ok(durable);
  assert.equal((durable as DraftPullRequestReceipt).state, "READY_FOR_CREATE");
  assert.equal((durable as DraftPullRequestReceipt).create_post_attempted, true, "write-ahead create intent must survive the crash");

  const restartedMachine = new DraftPullRequestStateMachine(
    new StatefulDraftRemoteClient(remote),
    async (receipt) => { durable = structuredClone(receipt); },
  );
  const recovered = await restartedMachine.execute(draftInput(structuredClone(durable as DraftPullRequestReceipt)));

  assert.equal(recovered.state, "OPEN");
  assert.equal(recovered.pull_number, 77);
  assert.equal(remote.createCalls, 1, "restart must adopt the exact remote Draft PR and must not POST a duplicate");
  assert.equal(remote.pulls.length, 1);
});
