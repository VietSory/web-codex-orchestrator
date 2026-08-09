import test from "node:test";
import assert from "node:assert/strict";
import { prepareBase } from "../src/git/base-commit.js";
import { GitBoundaryError, type GitCommandResult, type ResolvedRepository } from "../src/git/contracts.js";
import { GitRunner } from "../src/git/git-runner.js";

const baseCommit = "1".repeat(40);
const sealedUrl = "https://github.com/example/repo.git";

function repository(): ResolvedRepository {
  return {
    id: "repo",
    configured_path: "/tmp/repo",
    path: "/tmp/repo",
    remote: "origin",
    expected_remote_urls: [sealedUrl],
    fetch_policy: "always",
  };
}

class RecordingRunner extends GitRunner {
  readonly commands: string[][] = [];

  override async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.commands.push([...args]);
    if (args[0] === "show-ref") {
      const ref = args.at(-1) ?? "";
      return result(args, cwd, ref === "refs/remotes/origin/main" ? 0 : 1);
    }
    return result(args, cwd, 0);
  }
}

function result(args: readonly string[], cwd: string, exitCode: number): GitCommandResult {
  return {
    executable: "git",
    args: [...args],
    cwd,
    exitCode,
    stdout: "",
    stderr: "",
    duration_ms: 0,
  };
}

test("BASE-FETCH-HARDEN-001 production base fetch uses the sealed attested URL, never the mutable remote name", async () => {
  const runner = new RecordingRunner();
  const prepared = await prepareBase(repository(), "main", baseCommit, runner, sealedUrl);
  assert.equal(prepared.fetched, true);

  const fetch = runner.commands.find((args) => args[0] === "fetch");
  assert.ok(fetch);
  assert.equal(fetch![3], sealedUrl);
  assert.notEqual(fetch![3], "origin");
  assert.equal(fetch![4], "refs/heads/main:refs/remotes/origin/main");
});

test("BASE-FETCH-HARDEN-002 an unregistered sealed URL fails before network transport", async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    () => prepareBase(repository(), "main", baseCommit, runner, "https://github.com/attacker/repo.git"),
    (error: unknown) => error instanceof GitBoundaryError && error.code === "REMOTE_URL_MISMATCH",
  );
  assert.equal(runner.commands.some((args) => args[0] === "fetch"), false);
});
