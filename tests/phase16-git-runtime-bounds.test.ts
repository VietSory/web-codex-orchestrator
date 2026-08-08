import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { GitRunner } from "../src/git/git-runner.js";

const execFile = promisify(execFileCallback);

async function tempRepository(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFile("git", ["init", "-q", root]);
  return root;
}

test("P16-GIT-BOUND-001 oversized Git output fails closed instead of being parsed partially", async (t) => {
  const root = await tempRepository("wco-git-bound-output-");
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 32; index += 1) {
    await fs.writeFile(path.join(root, `untracked-${String(index).padStart(2, "0")}-${"x".repeat(24)}.txt`), "x");
  }
  const runner = new GitRunner(process.env, undefined, undefined, { stdoutMaxBytes: 128, stderrMaxBytes: 128 });
  const result = await runner.run(["status", "--porcelain=v1", "--untracked-files=all"], root);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /WCO_GIT_OUTPUT_LIMIT/);
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
});

test("P16-GIT-BOUND-002 hung Git subprocesses are terminated by the runner deadline", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-git-bound-timeout-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const fakeGit = path.join(root, "fake-git.mjs");
  await fs.writeFile(fakeGit, "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('late\\n'), 500);\n", { mode: 0o700 });
  await fs.chmod(fakeGit, 0o700);
  const runner = new GitRunner({ ...process.env, WCO_GIT_EXECUTABLE: fakeGit }, undefined, undefined, { localTimeoutMs: 50 });
  const result = await runner.run(["status"], root);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /WCO_GIT_TIMEOUT/);
  assert.ok(result.duration_ms < 1_000);
});
