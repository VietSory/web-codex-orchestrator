import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "../src/git/git-runner.js";
import { GitPublisher } from "../src/publish/git-publisher.js";
import type { GitPublishReceipt } from "../src/publish/contracts.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("P5A-REAL-001 publishes an unstaged verified replacement to a new remote branch", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-p5a-real-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const runner = new GitRunner(process.env);

  await git(runner, root, ["init", "--bare", remote]);
  await git(runner, repo, ["init", "-b", "main"]);
  await git(runner, repo, ["config", "user.name", "WCO Test"]);
  await git(runner, repo, ["config", "user.email", "wco@example.invalid"]);
  await fs.writeFile(path.join(repo, "file.txt"), "base\n");
  await git(runner, repo, ["add", "--", "file.txt"]);
  await git(runner, repo, ["commit", "-m", "base"]);
  const baseCommit = await git(runner, repo, ["rev-parse", "HEAD"]);
  await git(runner, repo, ["remote", "add", "origin", remote]);
  await git(runner, repo, ["push", "origin", "main"]);
  await git(runner, repo, ["switch", "-c", "codex/real-publish"]);
  await fs.writeFile(path.join(repo, "file.txt"), "changed\n");

  const digest = "a".repeat(64);
  let persisted: GitPublishReceipt | null = null;
  const publisher = new GitPublisher({
    runner,
    async inspectVerifiedChangeSet() {
      return { change_set_sha256: digest, paths: ["file.txt"] };
    },
    async persistReceipt(receipt) {
      persisted = structuredClone(receipt);
    },
  });

  const receipt = await publisher.publish({
    run_id: `task:${"b".repeat(64)}`,
    worktree_path: repo,
    base_commit: baseCommit,
    branch_name: "codex/real-publish",
    remote_name: "origin",
    allowed_remote_url: remote,
    allowed_branch_prefix: "codex/",
    deny_direct_push_branches: ["main", "master"],
    expected_change_set_sha256: digest,
    expected_paths: ["file.txt"],
    commit_message: "verified change",
    allow_force_push: false,
    allow_remote_branch_delete: false,
  });

  assert.equal(receipt.state, "PUSHED");
  assert.ok(receipt.commit_sha);
  assert.equal(receipt.remote_branch_sha, receipt.commit_sha);
  assert.equal((persisted as GitPublishReceipt | null)?.state, "PUSHED");
  const remoteBytes = await git(runner, repo, ["show", `${receipt.commit_sha}:file.txt`]);
  assert.equal(remoteBytes, "changed");
});
