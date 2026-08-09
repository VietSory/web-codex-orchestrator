import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const RUN_ID = `TASK-CLI:${"a".repeat(64)}`;

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli/index.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("compiled wco exposes the durable workflow through one public CLI", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /wco preview <task-bundle\.zip>/);
  assert.match(result.stdout, /wco run <task-bundle\.zip>/);
  assert.match(result.stdout, /wco status/);
  assert.match(result.stdout, /wco resume/);
  assert.match(result.stdout, /wco doctor/);
  assert.match(result.stdout, /wco continue/);
  assert.doesNotMatch(result.stdout, /wco-control/);
});

test("compiled wco uses explicit environment defaults for routine control commands", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-unified-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const result = await run(["next", "--json"], {
    WCO_RUN_ID: RUN_ID,
    WCO_STATE_DIR: state,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { transition: string }).transition, "REGISTER_WEB_PACK");
});

test("compiled preview rejects duplicate explicit state-dir even when it equals the environment default", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-preview-duplicate-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const result = await run([
    "preview",
    path.join(root, "missing.zip"),
    "--state-dir", state,
    "--state-dir", state,
  ], { WCO_STATE_DIR: state });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /wco preview <task-bundle\.zip>/);
  assert.equal(result.stderr, "");
});

test("compiled wco reports package version", async () => {
  const result = await run(["--version"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.2.0");
});
