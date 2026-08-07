import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { attestRevisionGitBoundary, calculateApprovedRevisionSnapshot, publishRevision } from "../src/revision/revision-git.js";
import { RevisionError } from "../src/revision/contracts.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

test("P8-MAINT-007: failing fresh pre-push authority check leaves remote at previous head", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-before-push-")));
  try {
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    await fs.mkdir(remote); await fs.mkdir(repo);
    const runner = new GitRunner();
    await git(runner, remote, ["init", "--bare"]);
    await git(runner, repo, ["init"]);
    await git(runner, repo, ["config", "user.name", "P8 Pre Push"]);
    await git(runner, repo, ["config", "user.email", "p8-pre-push@example.invalid"]);
    await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
    await git(runner, repo, ["add", "app.txt"]);
    await git(runner, repo, ["commit", "-m", "initial"]);
    await git(runner, repo, ["branch", "-M", "codex/feature"]);
    await git(runner, repo, ["remote", "add", "origin", remote]);
    await git(runner, repo, ["push", "-u", "origin", "codex/feature"]);
    const previous = await git(runner, repo, ["rev-parse", "HEAD"]);
    const boundary = await attestRevisionGitBoundary({ worktreePath: await fs.realpath(repo), branchName: "codex/feature", remoteName: "origin", expectedRemoteUrls: [await fs.realpath(remote)], previousHeadSha: previous, runner });

    await fs.writeFile(path.join(repo, "app.txt"), "v2\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: repo, approvedPaths: ["app.txt"] });
    let called = false;
    await assert.rejects(
      () => publishRevision({
        ...boundary,
        approvedPaths: ["app.txt"],
        approvedSnapshotSha256: snapshot,
        commitMessage: "revision",
        beforePush: async () => { called = true; throw new RevisionError("REVISION_PR_DRIFT", "PR became Ready before push."); },
      }, runner),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_PR_DRIFT"
    );
    assert.equal(called, true);
    const localHead = await git(runner, repo, ["rev-parse", "HEAD"]);
    assert.notEqual(localHead, previous, "the local commit should already exist at the persisted COMMITTED checkpoint");
    const remoteRow = await git(runner, repo, ["ls-remote", "--heads", "origin", "refs/heads/codex/feature"]);
    assert.equal(remoteRow.split(/\s+/)[0], previous, "pre-push failure must not move the remote branch");
    assert.equal(await git(runner, repo, ["rev-parse", `${localHead}^`]), previous);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
