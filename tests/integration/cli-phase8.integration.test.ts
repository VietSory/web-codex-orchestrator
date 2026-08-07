import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "..", "dist", "cli", "index.js");
const RUN_ID = `TASK:${"1".repeat(64)}`;

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI_PATH, ...args], { env: { ...process.env } }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

test("CLI-P8-001: compiled revision-status is read-only and returns null for absent state", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-cli-status-")));
  try {
    const res = await runCli(["revision-status", "--run-id", RUN_ID, "--state-dir", root, "--json"]);
    assert.equal(res.code, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), "null");
    assert.equal(res.stderr.trim(), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI-P8-002: compiled revise parser rejects a missing round before runtime/network access", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-cli-parse-")));
  try {
    const res = await runCli(["revise", "--run-id", RUN_ID, "--state-dir", root, "--config", path.join(root, "missing-config.json"), "--json"]);
    assert.equal(res.code, 1);
    const error = JSON.parse(res.stderr.trim());
    assert.equal(error.error, "REVISION_REQUEST_INVALID");
    assert.match(error.message, /--round/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI-P8-003: compiled revision-status rejects duplicate round flags deterministically", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-cli-duplicate-")));
  try {
    const res = await runCli(["revision-status", "--run-id", RUN_ID, "--state-dir", root, "--round", "1", "--round", "2", "--json"]);
    assert.equal(res.code, 1);
    const error = JSON.parse(res.stderr.trim());
    assert.equal(error.error, "REVISION_REQUEST_INVALID");
    assert.match(error.message, /Duplicate option/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
