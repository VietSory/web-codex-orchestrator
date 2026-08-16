import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetupCommand } from "../src/setup/setup-cli.js";

const exec = promisify(execFile);

async function initializedRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["config", "user.name", "UX Test"], { cwd: root });
  await exec("git", ["config", "user.email", "ux@example.invalid"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function setupOutput(cwd: string): Promise<{ code: number; output: string }> {
  const values: string[] = [];
  const code = await runSetupCommand(["--yes"], cwd, {
    write: (value) => values.push(value),
    error: (value) => values.push(value),
  });
  return { code, output: values.join("") };
}

test("first run outside a Git repository gives a direct recovery action instead of an internal error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "wco-ux-not-git-"));
  const result = await setupOutput(cwd);

  assert.equal(result.code, 1);
  assert.match(result.output, /WCO needs to be run inside a Git repository/i);
  assert.match(result.output, /cd.*project.*run `wco` again/i);
  assert.match(result.output, /project files and remote repository were not changed/i);
  assert.doesNotMatch(result.output, /REPOSITORY_DETECTION_FAILED/);
});

test("first run with no remote explains exactly what the user must add", async () => {
  const cwd = await initializedRepository("wco-ux-no-remote-");
  const result = await setupOutput(cwd);

  assert.equal(result.code, 1);
  assert.match(result.output, /Git repository has no remote/i);
  assert.match(result.output, /git remote -v/);
  assert.match(result.output, /run `wco` again/i);
  assert.doesNotMatch(result.output, /REPOSITORY_DETECTION_FAILED/);
});

test("first run with different fetch and push URLs explains the safe recovery instead of proceeding ambiguously", async () => {
  const cwd = await initializedRepository("wco-ux-remote-mismatch-");
  await exec("git", ["remote", "add", "origin", "https://github.com/example/fetch.git"], { cwd });
  await exec("git", ["remote", "set-url", "--push", "origin", "https://github.com/example/push.git"], { cwd });

  const result = await setupOutput(cwd);
  assert.equal(result.code, 1);
  assert.match(result.output, /different fetch and push URLs/i);
  assert.match(result.output, /Align the Git remote/i);
  assert.match(result.output, /run `wco` again/i);
  assert.doesNotMatch(result.output, /REPOSITORY_DETECTION_FAILED/);
});
