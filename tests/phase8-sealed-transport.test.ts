import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { attestRevisionGitBoundary, calculateApprovedRevisionSnapshot, publishRevision } from "../src/revision/revision-git.js";

async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

test("P8-MAINT-009: all Phase 8 network Git commands target the sealed URL, never the mutable remote name", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-sealed-transport-")));
  try {
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    await fs.mkdir(remote); await fs.mkdir(repo);
    const setup = new GitRunner();
    await git(setup, remote, ["init", "--bare"]);
    await git(setup, repo, ["init"]);
    await git(setup, repo, ["config", "user.name", "P8 Transport"]);
    await git(setup, repo, ["config", "user.email", "p8-transport@example.invalid"]);
    await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
    await git(setup, repo, ["add", "app.txt"]);
    await git(setup, repo, ["commit", "-m", "initial"]);
    await git(setup, repo, ["branch", "-M", "codex/feature"]);
    await git(setup, repo, ["remote", "add", "origin", remote]);
    await git(setup, repo, ["push", "-u", "origin", "codex/feature"]);
    const previous = await git(setup, repo, ["rev-parse", "HEAD"]);

    const commands: string[][] = [];
    class RecordingRunner extends GitRunner {
      override async run(args: readonly string[], cwd: string) {
        commands.push([...args]);
        return super.run(args, cwd);
      }
    }
    const runner = new RecordingRunner();
    const boundary = await attestRevisionGitBoundary({
      worktreePath: await fs.realpath(repo),
      branchName: "codex/feature",
      remoteName: "origin",
      expectedRemoteUrls: [await fs.realpath(remote)],
      previousHeadSha: previous,
      runner,
    });
    await fs.writeFile(path.join(repo, "app.txt"), "v2\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: repo, approvedPaths: ["app.txt"] });
    await publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "revision" }, runner);

    const network = commands.filter((args) => args[0] === "ls-remote" || args[0] === "push");
    assert.ok(network.length >= 3, "expected multiple remote attestations plus one push");
    for (const args of network) {
      const transport = args[0] === "push" ? args[1] : args[2];
      assert.equal(transport, boundary.remoteUrl, `${args[0]} must use the exact sealed transport URL`);
      assert.notEqual(transport, boundary.remoteName, `${args[0]} must not resolve the mutable remote name for network transport`);
    }
    assert.equal(network.filter((args) => args[0] === "push").length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
