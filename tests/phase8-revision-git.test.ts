import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import {
  attestRevisionGitBoundary,
  calculateApprovedRevisionSnapshot,
  publishRevision,
} from "../src/revision/revision-git.js";
import { RevisionError } from "../src/revision/contracts.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(): Promise<{ root: string; repo: string; remote: string; runner: GitRunner; previous: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-git-")));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(remote);
  await fs.mkdir(repo);
  const runner = new GitRunner();
  await git(runner, remote, ["init", "--bare"]);
  await git(runner, repo, ["init"]);
  await git(runner, repo, ["config", "user.name", "Phase Eight Test"]);
  await git(runner, repo, ["config", "user.email", "phase8@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
  await git(runner, repo, ["add", "app.txt"]);
  await git(runner, repo, ["commit", "-m", "initial"]);
  await git(runner, repo, ["branch", "-M", "codex/feature"]);
  await git(runner, repo, ["remote", "add", "origin", remote]);
  await git(runner, repo, ["push", "-u", "origin", "codex/feature"]);
  const previous = await git(runner, repo, ["rev-parse", "HEAD"]);
  return { root, repo: await fs.realpath(repo), remote: await fs.realpath(remote), runner, previous };
}

test("P8-GIT-001: revision publisher appends one normal commit to the same remote branch", async () => {
  const f = await fixture();
  try {
    const boundary = await attestRevisionGitBoundary({
      worktreePath: f.repo,
      branchName: "codex/feature",
      remoteName: "origin",
      expectedRemoteUrls: [f.remote],
      previousHeadSha: f.previous,
      runner: f.runner,
    });
    assert.equal(boundary.previousHeadSha, f.previous);

    await fs.writeFile(path.join(f.repo, "app.txt"), "v2\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner: f.runner, worktreePath: f.repo, approvedPaths: ["app.txt"] });
    const result = await publishRevision({
      ...boundary,
      approvedPaths: ["app.txt"],
      approvedSnapshotSha256: snapshot,
      commitMessage: "wco: revision round 1",
    }, f.runner);

    assert.notEqual(result.new_commit_sha, f.previous);
    assert.equal(result.remote_branch_sha, result.new_commit_sha);
    assert.equal(result.approved_snapshot_sha256, result.commit_tree_snapshot_sha256);
    const parents = (await git(f.runner, f.repo, ["rev-list", "--parents", "-n", "1", result.new_commit_sha])).split(/\s+/);
    assert.deepEqual(parents, [result.new_commit_sha, f.previous]);
    assert.equal(await git(f.runner, f.repo, ["status", "--porcelain"]), "");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("P8-GIT-002: remote drift blocks revision before commit/push", async () => {
  const f = await fixture();
  try {
    const boundary = await attestRevisionGitBoundary({
      worktreePath: f.repo,
      branchName: "codex/feature",
      remoteName: "origin",
      expectedRemoteUrls: [f.remote],
      previousHeadSha: f.previous,
      runner: f.runner,
    });

    const other = path.join(f.root, "other");
    await git(f.runner, f.root, ["clone", "--branch", "codex/feature", f.remote, other]);
    await git(f.runner, other, ["config", "user.name", "Other Writer"]);
    await git(f.runner, other, ["config", "user.email", "other@example.invalid"]);
    await fs.writeFile(path.join(other, "remote.txt"), "drift\n");
    await git(f.runner, other, ["add", "remote.txt"]);
    await git(f.runner, other, ["commit", "-m", "remote drift"]);
    await git(f.runner, other, ["push", "origin", "codex/feature"]);

    await fs.writeFile(path.join(f.repo, "app.txt"), "local revision\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner: f.runner, worktreePath: f.repo, approvedPaths: ["app.txt"] });
    await assert.rejects(
      () => publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "revision" }, f.runner),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_REMOTE_DRIFT"
    );
    assert.equal(await git(f.runner, f.repo, ["rev-parse", "HEAD"]), f.previous);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("P8-GIT-003: mutation after approval is rejected before staging", async () => {
  const f = await fixture();
  try {
    const boundary = await attestRevisionGitBoundary({
      worktreePath: f.repo,
      branchName: "codex/feature",
      remoteName: "origin",
      expectedRemoteUrls: [f.remote],
      previousHeadSha: f.previous,
      runner: f.runner,
    });
    await fs.writeFile(path.join(f.repo, "app.txt"), "approved\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner: f.runner, worktreePath: f.repo, approvedPaths: ["app.txt"] });
    await fs.writeFile(path.join(f.repo, "app.txt"), "mutated after approval\n");
    await assert.rejects(
      () => publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "revision" }, f.runner),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_COMMIT_FAILED" && error.message.includes("approved revision snapshot")
    );
    assert.equal(await git(f.runner, f.repo, ["rev-parse", "HEAD"]), f.previous);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("P8-GIT-004: publisher never emits force, amend, rebase or branch deletion commands", async () => {
  const f = await fixture();
  try {
    const commands: string[][] = [];
    class RecordingRunner extends GitRunner {
      override async run(args: readonly string[], cwd: string) {
        commands.push([...args]);
        return super.run(args, cwd);
      }
    }
    const runner = new RecordingRunner();
    const boundary = await attestRevisionGitBoundary({
      worktreePath: f.repo,
      branchName: "codex/feature",
      remoteName: "origin",
      expectedRemoteUrls: [f.remote],
      previousHeadSha: f.previous,
      runner,
    });
    await fs.writeFile(path.join(f.repo, "app.txt"), "v2\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: f.repo, approvedPaths: ["app.txt"] });
    await publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "revision" }, runner);

    const flattened = commands.flat().join(" ");
    assert.equal(flattened.includes("--force"), false);
    assert.equal(flattened.includes("--force-with-lease"), false);
    assert.equal(flattened.includes("--amend"), false);
    assert.equal(flattened.includes("rebase"), false);
    assert.equal(commands.some((args) => args[0] === "push" && args.some((arg) => arg.startsWith(":"))), false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
