import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  GitPublishError,
  type GitCommandResult,
  type GitCommandRunner,
  type GitPublishReceipt,
  type GitPublishRequest,
  type VerifiedChangeSet,
} from "../src/publish/contracts.js";
import { GitPublisher } from "../src/publish/git-publisher.js";
import {
  readGitPublishReceipt,
  writeGitPublishReceipt,
} from "../src/publish/publish-store.js";

class TestGitRunner implements GitCommandRunner {
  constructor(private readonly hooksPath: string) {}

  run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          `core.hooksPath=${this.hooksPath}`,
          "-c",
          "credential.helper=",
          "-c",
          "protocol.file.allow=always",
          ...args,
        ],
        {
          cwd,
          shell: false,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_AUTHOR_NAME: "WCO Phase 5A Test",
            GIT_AUTHOR_EMAIL: "wco-phase5a@example.invalid",
            GIT_COMMITTER_NAME: "WCO Phase 5A Test",
            GIT_COMMITTER_EMAIL: "wco-phase5a@example.invalid",
          },
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, signal });
      });
    });
  }
}

async function requireGit(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function inspectFixtureChangeSet(
  runner: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
): Promise<VerifiedChangeSet> {
  const digest = createHash("sha256");

  for (const relativePath of [...paths].sort()) {
    digest.update(relativePath);
    digest.update("\u0000");
    digest.update(await readFile(path.join(cwd, relativePath)));
    digest.update("\u0000");
  }

  const status = await requireGit(
    runner,
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  digest.update(status);

  return {
    change_set_sha256: digest.digest("hex"),
    paths: [...paths],
  };
}

interface Fixture {
  root: string;
  worktree: string;
  remote: string;
  runner: TestGitRunner;
  baseCommit: string;
  branchName: string;
  receiptPath: string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-phase5a-"));
  const worktree = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const hooks = path.join(root, "empty-hooks");
  const receiptPath = path.join(root, "state", "publish.json");
  await mkdir(worktree, { recursive: true });
  await mkdir(hooks, { recursive: true });
  await chmod(hooks, 0o700);

  const runner = new TestGitRunner(hooks);
  await requireGit(runner, root, ["init", "--bare", remote]);
  await requireGit(runner, worktree, ["init"]);
  await writeFile(path.join(worktree, "README.md"), "base\n", "utf8");
  await requireGit(runner, worktree, ["add", "README.md"]);
  await requireGit(runner, worktree, ["commit", "-m", "base"]);
  const baseCommit = await requireGit(runner, worktree, ["rev-parse", "HEAD"]);
  const branchName = "codex/phase-5a-fixture";
  await requireGit(runner, worktree, ["switch", "-c", branchName]);
  await requireGit(runner, worktree, ["remote", "add", "origin", remote]);

  return {
    root,
    worktree,
    remote,
    runner,
    baseCommit,
    branchName,
    receiptPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(
  fixture: Fixture,
  changeSet: VerifiedChangeSet,
): GitPublishRequest {
  return {
    run_id: "TASK-PHASE5A:test",
    worktree_path: fixture.worktree,
    base_commit: fixture.baseCommit,
    branch_name: fixture.branchName,
    remote_name: "origin",
    allowed_remote_url: fixture.remote,
    allowed_branch_prefix: "codex/",
    deny_direct_push_branches: ["main", "master"],
    expected_change_set_sha256: changeSet.change_set_sha256,
    expected_paths: changeSet.paths,
    commit_message: "Publish verified Phase 5A fixture",
    allow_force_push: false,
    allow_remote_branch_delete: false,
  };
}

test("P5A-001: commit and push the exact attested change set to a new branch", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );

    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: (receipt) =>
        writeGitPublishReceipt(fixture.receiptPath, receipt),
    });

    const receipt = await publisher.publish(request(fixture, changeSet));
    assert.equal(receipt.state, "PUSHED");
    assert.ok(receipt.commit_sha);
    assert.equal(receipt.commit_sha, receipt.remote_branch_sha);
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-parse", "HEAD^"]),
      fixture.baseCommit,
    );
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${fixture.branchName}`,
      ]).then((line) => line.split(/\s+/)[0]),
      receipt.commit_sha,
    );
    assert.deepEqual(await readGitPublishReceipt(fixture.receiptPath), receipt);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-002: a stale digest fails before staging or committing", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "approved\n", "utf8");
    const approved = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    await writeFile(path.join(fixture.worktree, "feature.txt"), "tampered\n", "utf8");

    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish(request(fixture, approved)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_CHANGE_SET_STALE",
    );

    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-parse", "HEAD"]),
      fixture.baseCommit,
    );
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["diff", "--cached", "--name-only"]),
      "",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-003: direct pushes and force-push capability are rejected locally", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    const valid = request(fixture, changeSet);
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => changeSet,
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish({ ...valid, branch_name: "main" }),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_BRANCH_POLICY_VIOLATION",
    );

    await assert.rejects(
      () => publisher.publish({ ...valid, allow_force_push: true } as never),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_REQUEST_INVALID",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-004: retrying a PUSHED receipt is idempotent", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let latestReceipt: GitPublishReceipt | null = null;
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => { latestReceipt = structuredClone(receipt); },
    });

    const first = await publisher.publish(request(fixture, changeSet));
    const before = await requireGit(fixture.runner, fixture.worktree, ["rev-list", "--count", "HEAD"]);
    const second = await publisher.publish(
      request(fixture, changeSet),
      structuredClone(latestReceipt ?? first),
    );
    const after = await requireGit(fixture.runner, fixture.worktree, ["rev-list", "--count", "HEAD"]);

    assert.deepEqual(second, first);
    assert.equal(before, after);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-005: an unexpected existing remote branch is never overwritten", async () => {
  const fixture = await createFixture();

  try {
    await requireGit(fixture.runner, fixture.worktree, [
      "push",
      "origin",
      `${fixture.baseCommit}:refs/heads/${fixture.branchName}`,
    ]);
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => changeSet,
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_REMOTE_BRANCH_EXISTS",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-006: a persisted COMMITTED receipt resumes with one non-force push", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );

    let failPush = true;
    const failOnceRunner: GitCommandRunner = {
      run: async (args, cwd) => {
        if (args[0] === "push" && failPush) {
          failPush = false;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "simulated bounded push failure",
          };
        }

        return fixture.runner.run(args, cwd);
      },
    };

    let persisted: GitPublishReceipt | null = null;
    const firstPublisher = new GitPublisher({
      runner: failOnceRunner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => { persisted = structuredClone(receipt); },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_PUSH_FAILED",
    );

    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "COMMITTED");
    assert.ok((persisted as GitPublishReceipt).commit_sha);

    const secondPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => {
        throw new Error("A COMMITTED resume must not re-inspect an already committed worktree.");
      },
      persistReceipt: async (receipt) => { persisted = structuredClone(receipt); },
    });

    const completed = await secondPublisher.publish(
      request(fixture, changeSet),
      structuredClone(persisted as GitPublishReceipt),
    );

    assert.equal(completed.state, "PUSHED");
    assert.equal(completed.commit_sha, completed.remote_branch_sha);
  } finally {
    await fixture.cleanup();
  }
});
