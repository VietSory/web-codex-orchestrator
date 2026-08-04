import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  GitCommandResult,
  GitCommandRunner,
  VerifiedChangeSet,
} from "../src/publish/contracts.js";
import { publishPreparedPhase4Run } from "../src/publish/phase4-publish-service.js";
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
