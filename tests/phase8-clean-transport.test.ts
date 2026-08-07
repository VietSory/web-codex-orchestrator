import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { runCleanLsRemote, runCleanPush } from "../src/revision/revision-network.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

test("P8-MAINT-010: clean Phase 8 transport defeats worktree-local insteadOf and pushInsteadOf rewrites", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-clean-transport-")));
  try {
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const intended = path.join(root, "intended.git");
    const rogue = path.join(root, "rogue.git");
    await fs.mkdir(home);
    await fs.mkdir(repo);
    await fs.mkdir(intended);
    await fs.mkdir(rogue);
    const runner = new GitRunner({ ...process.env, HOME: home });

    await git(runner, intended, ["init", "--bare"]);
    await git(runner, rogue, ["init", "--bare"]);
    await git(runner, repo, ["init"]);
    await git(runner, repo, ["config", "user.name", "P8 Clean Transport"]);
    await git(runner, repo, ["config", "user.email", "p8-clean@example.invalid"]);
    await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
    await git(runner, repo, ["add", "app.txt"]);
    await git(runner, repo, ["commit", "-m", "initial"]);
    await git(runner, repo, ["branch", "-M", "codex/feature"]);
    const previous = await git(runner, repo, ["rev-parse", "HEAD"]);
    await git(runner, repo, ["push", intended, "codex/feature:refs/heads/codex/feature"]);

    // A normal network command from the product worktree is now poisoned: Git
    // rewrites the intended destination to the empty rogue bare repository.
    await git(runner, repo, ["config", `url.${rogue}.insteadOf`, intended]);
    await git(runner, repo, ["config", `url.${rogue}.pushInsteadOf`, intended]);
    const poisoned = await runner.run(["ls-remote", "--heads", intended, "refs/heads/codex/feature"], repo);
    assert.equal(poisoned.exitCode, 0);
    assert.equal(poisoned.stdout.trim(), "", "control case must demonstrate that local URL rewriting is active");

    const cleanObserved = await runCleanLsRemote(runner, intended, "codex/feature");
    assert.equal(cleanObserved.exitCode, 0, cleanObserved.stderr);
    assert.equal(cleanObserved.stdout.trim().split(/\s+/)[0], previous, "clean transport must observe the intended remote, not the rogue rewrite");

    await fs.writeFile(path.join(repo, "app.txt"), "v2\n");
    await git(runner, repo, ["add", "app.txt"]);
    await git(runner, repo, ["commit", "-m", "revision"]);
    const next = await git(runner, repo, ["rev-parse", "HEAD"]);
    const pushed = await runCleanPush(runner, repo, intended, next, "codex/feature");
    assert.equal(pushed.exitCode, 0, pushed.stderr);

    const intendedHead = await git(runner, intended, ["rev-parse", "refs/heads/codex/feature"]);
    assert.equal(intendedHead, next, "clean sender must move the intended remote to the exact revision commit");
    const rogueHead = await runner.run(["rev-parse", "--verify", "refs/heads/codex/feature"], rogue);
    assert.notEqual(rogueHead.exitCode, 0, "rogue remote must remain untouched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
