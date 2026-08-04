import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  GitCommandResult,
  GitCommandRunner,
  VerifiedChangeSet,
} from "../src/publish/contracts.js";
import {
  publishPhase4Run,
  publishPreparedPhase4Run,
} from "../src/publish/phase4-publish-service.js";
import { readGitPublishReceipt } from "../src/publish/publish-store.js";

class AdapterGitRunner implements GitCommandRunner {
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
            GIT_AUTHOR_NAME: "WCO Phase 5A Adapter Test",
            GIT_AUTHOR_EMAIL: "wco-phase5a-adapter@example.invalid",
            GIT_COMMITTER_NAME: "WCO Phase 5A Adapter Test",
            GIT_COMMITTER_EMAIL: "wco-phase5a-adapter@example.invalid",
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

async function git(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function inspect(
  runner: GitCommandRunner,
  cwd: string,
): Promise<VerifiedChangeSet> {
  const contents = await readFile(path.join(cwd, "feature.txt"));
  const status = await git(
    runner,
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  const digest = createHash("sha256")
    .update("feature.txt")
    .update("\u0000")
    .update(contents)
    .update("\u0000")
    .update(status)
    .digest("hex");

  return { change_set_sha256: digest, paths: ["feature.txt"] };
}

test("P5A-012/P5A-013: a prepared READY_FOR_PUBLISH context publishes once and resumes idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-phase5a-adapter-"));
  const worktree = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const hooks = path.join(root, "hooks");
  const executionDirectory = path.join(root, "state", "runs", "task", "archive", "execution");

  try {
    await mkdir(worktree, { recursive: true });
    await mkdir(hooks, { recursive: true });
    const runner = new AdapterGitRunner(hooks);
    await git(runner, root, ["init", "--bare", remote]);
    await git(runner, worktree, ["init"]);
    await writeFile(path.join(worktree, "README.md"), "base\n", "utf8");
    await git(runner, worktree, ["add", "README.md"]);
    await git(runner, worktree, ["commit", "-m", "base"]);
    const baseCommit = await git(runner, worktree, ["rev-parse", "HEAD"]);
    const branchName = "codex/phase-5a-adapter-fixture";
    await git(runner, worktree, ["switch", "-c", branchName]);
    await git(runner, worktree, ["remote", "add", "origin", remote]);
    await writeFile(path.join(worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspect(runner, worktree);

    const context = {
      runId: `task:${"a".repeat(64)}`,
      taskId: "task",
      archiveSha256: "a".repeat(64),
      stateDirectory: path.join(root, "state"),
      executionDirectory,
      worktreePath: worktree,
      baseCommit,
      branchName,
      remoteName: "origin",
      allowedRemoteUrl: remote,
      allowedBranchPrefix: "codex/",
      denyDirectPushBranches: ["main", "master"],
      expectedChangeSetSha256: changeSet.change_set_sha256,
      expectedPaths: ["feature.txt"],
      commitMessage: "Apply verified task task: adapter fixture",
      runner,
      inspectVerifiedChangeSet: () => inspect(runner, worktree),
    };
    const receipt = await publishPreparedPhase4Run(context);

    assert.equal(receipt.state, "PUSHED");
    assert.equal(receipt.commit_sha, receipt.remote_branch_sha);
    assert.equal(await git(runner, worktree, ["rev-parse", "HEAD^"]), baseCommit);
    assert.equal(
      await git(runner, worktree, [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${branchName}`,
      ]).then((line) => line.split(/\s+/)[0]),
      receipt.commit_sha,
    );

    const persisted = await readGitPublishReceipt(
      path.join(executionDirectory, "publish", "git-publish.json"),
    );
    assert.deepEqual(persisted, receipt);

    const repeated = await publishPreparedPhase4Run({
      ...context,
      inspectVerifiedChangeSet: async () => {
        throw new Error("A PUSHED retry must not inspect the now-clean worktree.");
      },
    });
    assert.deepEqual(repeated, receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { createPhase4Fixture } from "./helpers/phase4-fixture.js";
import { updateChecksums } from "./helpers/zip-fixture.js";
import { executeRun } from "../src/execution/execution-service.js";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import { fileURLToPath } from "node:url";

async function createTheExistingPhase4Fixture(options: {
  state: "READY_FOR_PUBLISH";
  localBareRemote: boolean;
  approvedProductChange: { path: string; contents: string };
  deliveryBranch: string;
}) {
  const fixture = await createPhase4Fixture();
  let repositoryRoot = process.cwd();
  const runner = new AdapterGitRunner(path.join(fixture.root, "hooks"));
  
  if (options.localBareRemote) {
    const remoteDir = path.join(fixture.root, "remote.git");
    await git(runner, fixture.root, ["init", "--bare", remoteDir]);
    await git(runner, fixture.worktree, ["remote", "add", "origin", remoteDir]);
    
    const configPath = fixture.configPath;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repositories.repo.expected_remote_urls = [remoteDir];
    config.publish = {
      identity: { name: "WCO Phase 5A Adapter Test", email: "wco-phase5a-adapter@example.invalid" },
      authentication: { mode: "none" }
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    
    const manifestPath = path.join(fixture.bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.delivery.branch_name = options.deliveryBranch;
    manifest.task_id = "task";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await updateChecksums(fixture.bundle);

    const runPath = path.join(fixture.state, "runs", "task", fixture.runId.split(":")[1]!);
    const runJson = JSON.parse(await readFile(path.join(runPath, "run.json"), "utf8"));
    runJson.remote_url = remoteDir;
    runJson.branch_name = options.deliveryBranch;
    await writeFile(path.join(runPath, "run.json"), JSON.stringify(runJson, null, 2));
  }

  await git(runner, fixture.worktree, ["branch", "-m", options.deliveryBranch]);

  const client = new FakeAgentClient([
    (request: any) => request.role === "implementer" && request.read_only ? { status: "COMPATIBLE", summary: "ok", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null } :
    request.role === "implementer" ? (() => {
      writeFileSync(path.join(fixture.worktree, options.approvedProductChange.path), options.approvedProductChange.contents, "utf8");
      return { status: "READY_FOR_VERIFICATION", summary: "done", changed_files_claimed: [options.approvedProductChange.path], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null };
    })() :
    (() => {
      const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64);
      return { verdict: "APPROVE", reviewed_change_set_sha256: digest, summary: "ok", acceptance_results: [{ acceptance_id: "AC-001", status: "PASS", evidence: ["fake"] }, { acceptance_id: "AC-002", status: "PASS", evidence: ["fake"] }], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], human_action: null };
    })()
  ]);

  const result = await executeRun({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.configPath,
    agentClient: client,
    sandbox: new FakeVerificationSandbox()
  });
  
  assert.equal(result.state, options.state);

  return {
    ...fixture,
    repositoryRoot,
    stateDirectory: fixture.state,
    branchName: options.deliveryBranch,
    executionDirectory: path.join(fixture.state, "runs", "task", fixture.runId.split(":")[1]!, "execution"),
    git: (cwd: string, args: string[]) => git(runner, cwd, args),
    productCommitCount: async () => parseInt(await git(runner, fixture.worktree, ["rev-list", "--count", `${fixture.base}..HEAD`]), 10),
    payloadMarkerExists: async () => {
      try {
        await import("node:fs/promises").then(fs => fs.stat(path.join(fixture.state, "runs", "task", fixture.runId.split(":")[1]!, "execution", "payload-executed")));
        return true;
      } catch {
        return false;
      }
    }
  };
}

test(
  "P5A-016: READY_FOR_PUBLISH production state publishes through publishPhase4Run",
  async () => {
    /*
     * Use the existing Phase 4 fixture builder. Do not manually bypass
     * execution-store, intake checksum verification or execution validation.
     */
    const fixture = await createTheExistingPhase4Fixture({
      state: "READY_FOR_PUBLISH",
      localBareRemote: true,
      approvedProductChange: {
        path: "src/feature.txt",
        contents: "verified production publish\n",
      },
      deliveryBranch:
        "codex/phase-5a-production-fixture",
    });

    try {
      const baseHead = await fixture.git(
        fixture.worktree,
        ["rev-parse", "HEAD"],
      );

      const receipt = await publishPhase4Run({
        runId: fixture.runId,
        stateDirectory: fixture.stateDirectory,
        configPath: fixture.configPath,
      });

      assert.equal(receipt.state, "PUSHED");
      assert.ok(receipt.commit_sha);
      assert.equal(
        receipt.commit_sha,
        receipt.remote_branch_sha,
      );

      assert.equal(
        await fixture.git(
          fixture.worktree,
          ["rev-parse", "HEAD^"],
        ),
        baseHead,
      );

      assert.equal(
        await fixture.git(
          fixture.worktree,
          [
            "rev-list",
            "--count",
            `${baseHead}..HEAD`,
          ],
        ),
        "1",
      );

      const remoteSha = await fixture.git(
        fixture.worktree,
        [
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${fixture.branchName}`,
        ],
      ).then((line) => line.split(/\s+/)[0]);

      assert.equal(remoteSha, receipt.commit_sha);

      const persisted =
        await readGitPublishReceipt(
          path.join(
            fixture.executionDirectory,
            "publish",
            "git-publish.json",
          ),
        );

      assert.deepEqual(persisted, receipt);

      assert.equal(
        await fixture.productCommitCount(),
        1,
      );

      assert.equal(
        await fixture.payloadMarkerExists(),
        false,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

async function runWcoCli(
  cwd: string,
  args: readonly string[],
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const tsxCli = fileURLToPath(
    new URL(
      "../node_modules/tsx/dist/cli.mjs",
      import.meta.url,
    ),
  );

  const wcoCli = fileURLToPath(
    new URL("../src/cli/index.ts", import.meta.url),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        wcoCli,
        ...args,
      ],
      {
        cwd,
        shell: false,
        env: {
          ...process.env,
          CI: "true",
          WCO_RUN_CODEX_INTEGRATION: "0",
          WCO_RUN_SANDBOX_INTEGRATION: "0",
        },
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on(
      "data",
      (chunk: string) => {
        stdout += chunk;
      },
    );

    child.stderr.on(
      "data",
      (chunk: string) => {
        stderr += chunk;
      },
    );

    child.once("error", reject);

    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

test(
  "P5A-017: CLI publish --json publishes once and retries idempotently",
  async () => {
    const fixture = await createTheExistingPhase4Fixture({
      state: "READY_FOR_PUBLISH",
      localBareRemote: true,
      approvedProductChange: {
        path: "src/feature.txt",
        contents: "verified CLI publish\n",
      },
      deliveryBranch:
        "codex/phase-5a-cli-fixture",
    });

    try {
      const baseHead = await fixture.git(
        fixture.worktree,
        ["rev-parse", "HEAD"],
      );

      const cliArgs = [
        "publish",
        "--run-id",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--config",
        fixture.configPath,
        "--json",
      ];

      const first = await runWcoCli(
        fixture.repositoryRoot,
        cliArgs,
      );

      assert.equal(
        first.exitCode,
        0,
        first.stderr,
      );

      assert.equal(
        first.stderr,
        "",
      );

      const firstLines = first.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);

      assert.equal(firstLines.length, 1);

      const firstReceipt = JSON.parse(
        firstLines[0]!,
      ) as {
        state: string;
        commit_sha: string | null;
        remote_branch_sha: string | null;
      };

      assert.equal(firstReceipt.state, "PUSHED");
      assert.ok(firstReceipt.commit_sha);
      assert.equal(
        firstReceipt.commit_sha,
        firstReceipt.remote_branch_sha,
      );

      const firstHead = await fixture.git(
        fixture.worktree,
        ["rev-parse", "HEAD"],
      );

      const second = await runWcoCli(
        fixture.repositoryRoot,
        cliArgs,
      );

      assert.equal(
        second.exitCode,
        0,
        second.stderr,
      );

      assert.equal(second.stderr, "");

      const secondLines = second.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);

      assert.equal(secondLines.length, 1);

      const secondReceipt = JSON.parse(
        secondLines[0]!,
      ) as typeof firstReceipt;

      assert.deepEqual(
        secondReceipt,
        firstReceipt,
      );

      assert.equal(
        await fixture.git(
          fixture.worktree,
          ["rev-parse", "HEAD"],
        ),
        firstHead,
      );

      assert.equal(
        await fixture.git(
          fixture.worktree,
          [
            "rev-list",
            "--count",
            `${baseHead}..HEAD`,
          ],
        ),
        "1",
      );

      const remoteSha = await fixture.git(
        fixture.worktree,
        [
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${fixture.branchName}`,
        ],
      ).then((line) => line.split(/\s+/)[0]);

      assert.equal(
        remoteSha,
        firstReceipt.commit_sha,
      );

      assert.equal(
        await fixture.payloadMarkerExists(),
        false,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test("P5A-018: production publishPhase4Run throws PUBLISH_IDENTITY_UNAVAILABLE and does not modify worktree if identity is missing", async () => {
  const fixture = await createTheExistingPhase4Fixture({
    state: "READY_FOR_PUBLISH",
    localBareRemote: true,
    approvedProductChange: { path: "src/feature.txt", contents: "test" },
    deliveryBranch: "codex/phase-5a-p5a-018",
  });
  try {
    const configPath = fixture.configPath;
    const { readFile, writeFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    delete config.publish;
    await writeFile(configPath, JSON.stringify(config));

    const baseHead = await fixture.git(fixture.worktree, ["rev-parse", "HEAD"]);
    await assert.rejects(
      publishPhase4Run({ runId: fixture.runId, stateDirectory: fixture.stateDirectory, configPath: fixture.configPath }),
      { code: "PUBLISH_IDENTITY_UNAVAILABLE" }
    );

    assert.equal(await fixture.git(fixture.worktree, ["rev-parse", "HEAD"]), baseHead);
    assert.equal(await fixture.productCommitCount(), 0);
    const diff = await fixture.git(fixture.worktree, ["diff", "--cached", "--name-only"]);
    assert.equal(diff, "");
    
    // P5A-018: no COMMITTED/PUSHED receipt
    const executionDirectory = path.join(fixture.stateDirectory, "execution", fixture.runId);
    const receiptPath = path.join(executionDirectory, "publish", "git-publish.json");
    try {
      const { readFile } = await import("node:fs/promises");
      const receiptRaw = await readFile(receiptPath, "utf8");
      const receipt = JSON.parse(receiptRaw);
      assert.notEqual(receipt.state, "COMMITTED");
      assert.notEqual(receipt.state, "PUSHED");
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err; // ENOENT is acceptable
    }
    const remoteHeads = await fixture.git(fixture.worktree, ["ls-remote", "--heads", "origin"]);
    assert.doesNotMatch(remoteHeads, /codex\/phase-5a-p5a-018/);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-019: trusted identity is used as author and committer", async () => {
  const fixture = await createTheExistingPhase4Fixture({
    state: "READY_FOR_PUBLISH",
    localBareRemote: true,
    approvedProductChange: { path: "src/feature.txt", contents: "test identity" },
    deliveryBranch: "codex/phase-5a-p5a-019",
  });
  
  const previousEnv = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };

  try {
    process.env.GIT_AUTHOR_NAME = "Ambient Wrong Author";
    process.env.GIT_AUTHOR_EMAIL = "ambient-author@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Ambient Wrong Committer";
    process.env.GIT_COMMITTER_EMAIL = "ambient-committer@example.invalid";

    await publishPhase4Run({ runId: fixture.runId, stateDirectory: fixture.stateDirectory, configPath: fixture.configPath });
    
    // Verify commit author and committer
    const authorName = await fixture.git(fixture.worktree, ["log", "-1", "--format=%an"]);
    const authorEmail = await fixture.git(fixture.worktree, ["log", "-1", "--format=%ae"]);
    const committerName = await fixture.git(fixture.worktree, ["log", "-1", "--format=%cn"]);
    const committerEmail = await fixture.git(fixture.worktree, ["log", "-1", "--format=%ce"]);
    
    assert.equal(authorName, "WCO Phase 5A Adapter Test");
    assert.equal(authorEmail, "wco-phase5a-adapter@example.invalid");
    assert.equal(committerName, "WCO Phase 5A Adapter Test");
    assert.equal(committerEmail, "wco-phase5a-adapter@example.invalid");
  } finally {
    if (previousEnv.authorName !== undefined) process.env.GIT_AUTHOR_NAME = previousEnv.authorName; else delete process.env.GIT_AUTHOR_NAME;
    if (previousEnv.authorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = previousEnv.authorEmail; else delete process.env.GIT_AUTHOR_EMAIL;
    if (previousEnv.committerName !== undefined) process.env.GIT_COMMITTER_NAME = previousEnv.committerName; else delete process.env.GIT_COMMITTER_NAME;
    if (previousEnv.committerEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = previousEnv.committerEmail; else delete process.env.GIT_COMMITTER_EMAIL;
    await fixture.cleanup();
  }
});
