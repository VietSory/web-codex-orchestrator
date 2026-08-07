import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "../src/git/git-runner.js";
import { attestRevisionGitBoundary, calculateApprovedRevisionSnapshot, publishRevision } from "../src/revision/revision-git.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("P8-GIT-REC-001: retry adopts the exact already-created revision commit without creating a second commit", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-git-recover-")));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const runner = new GitRunner();
  try {
    await fs.mkdir(remote); await fs.mkdir(repo);
    await git(runner, remote, ["init", "--bare"]);
    await git(runner, repo, ["init"]);
    await git(runner, repo, ["config", "user.name", "Phase Eight Recovery"]);
    await git(runner, repo, ["config", "user.email", "phase8-recovery@example.invalid"]);
    await fs.writeFile(path.join(repo, "app.txt"), "before\n");
    await git(runner, repo, ["add", "app.txt"]); await git(runner, repo, ["commit", "-m", "initial"]); await git(runner, repo, ["branch", "-M", "codex/feature"]); await git(runner, repo, ["remote", "add", "origin", remote]); await git(runner, repo, ["push", "-u", "origin", "codex/feature"]);
    const previous = await git(runner, repo, ["rev-parse", "HEAD"]);
    const boundary = await attestRevisionGitBoundary({ worktreePath: await fs.realpath(repo), branchName: "codex/feature", remoteName: "origin", expectedRemoteUrls: [await fs.realpath(remote)], previousHeadSha: previous, runner });

    await fs.writeFile(path.join(repo, "app.txt"), "after\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: repo, approvedPaths: ["app.txt"] });

    // Simulate crash after the approved bytes were committed but before Phase 8
    // persisted COMMITTED/PUSHED state.
    await git(runner, repo, ["add", "app.txt"]);
    await git(runner, repo, ["commit", "--no-verify", "--no-gpg-sign", "-m", "wco: revision 1"]);
    const crashCommit = await git(runner, repo, ["rev-parse", "HEAD"]);
    assert.notEqual(crashCommit, previous);
    assert.equal(await git(runner, repo, ["ls-remote", "--heads", "origin", "refs/heads/codex/feature"]).then((row) => row.split(/\s+/)[0]!), previous);

    const result = await publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "wco: revision 1" }, runner);
    assert.equal(result.recovered_existing_commit, true);
    assert.equal(result.new_commit_sha, crashCommit);
    assert.equal(result.remote_branch_sha, crashCommit);
    assert.equal(await git(runner, repo, ["rev-list", "--count", `${previous}..HEAD`]), "1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
