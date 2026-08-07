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

async function makeFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-checkpoint-")));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(remote); await fs.mkdir(repo);
  const baseRunner = new GitRunner();
  await git(baseRunner, remote, ["init", "--bare"]);
  await git(baseRunner, repo, ["init"]);
  await git(baseRunner, repo, ["config", "user.name", "Phase Eight Checkpoint"]);
  await git(baseRunner, repo, ["config", "user.email", "phase8-checkpoint@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "before\n");
  await git(baseRunner, repo, ["add", "app.txt"]); await git(baseRunner, repo, ["commit", "-m", "initial"]);
  await git(baseRunner, repo, ["branch", "-M", "codex/feature"]); await git(baseRunner, repo, ["remote", "add", "origin", remote]); await git(baseRunner, repo, ["push", "-u", "origin", "codex/feature"]);
  return { root, repo: await fs.realpath(repo), remote: await fs.realpath(remote), previous: await git(baseRunner, repo, ["rev-parse", "HEAD"]), baseRunner };
}

test("P8-PUB-001: COMMITTED callback executes before any push and callback failure leaves remote unchanged", async () => {
  const f = await makeFixture();
  try {
    const commands: string[][] = [];
    class RecordingRunner extends GitRunner {
      override async run(args: readonly string[], cwd: string) {
        commands.push([...args]);
        return super.run(args, cwd);
      }
    }
    const runner = new RecordingRunner();
    const boundary = await attestRevisionGitBoundary({ worktreePath:f.repo, branchName:"codex/feature", remoteName:"origin", expectedRemoteUrls:[f.remote], previousHeadSha:f.previous, runner });
    await fs.writeFile(path.join(f.repo, "app.txt"), "after\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath:f.repo, approvedPaths:["app.txt"] });
    let callbackCommit = "";
    await assert.rejects(
      () => publishRevision({ ...boundary, approvedPaths:["app.txt"], approvedSnapshotSha256:snapshot, commitMessage:"wco: revision 1", onCommitted:async(commitSha)=>{
        callbackCommit = commitSha;
        assert.equal(commands.some((args)=>args[0]==="push"), false, "push occurred before COMMITTED checkpoint");
        throw new Error("simulated receipt persistence failure");
      } }, runner),
      /simulated receipt persistence failure/
    );
    assert.match(callbackCommit, /^[a-f0-9]{40}$/);
    assert.equal(await git(f.baseRunner, f.repo, ["rev-parse", "HEAD"]), callbackCommit);
    const remoteRow = await git(f.baseRunner, f.repo, ["ls-remote", "--heads", "origin", "refs/heads/codex/feature"]);
    assert.equal(remoteRow.split(/\s+/)[0], f.previous);

    // Exact retry adopts the already-created commit and pushes it once.
    const recovered = await publishRevision({ ...boundary, approvedPaths:["app.txt"], approvedSnapshotSha256:snapshot, commitMessage:"wco: revision 1", onCommitted:async(commitSha,recoveredCommit)=>{
      assert.equal(commitSha, callbackCommit);
      assert.equal(recoveredCommit, true);
    } }, f.baseRunner);
    assert.equal(recovered.new_commit_sha, callbackCommit);
    assert.equal(recovered.remote_branch_sha, callbackCommit);
    assert.equal(await git(f.baseRunner, f.repo, ["rev-list", "--count", `${f.previous}..HEAD`]), "1");
  } finally {
    await fs.rm(f.root, { recursive:true, force:true });
  }
});
