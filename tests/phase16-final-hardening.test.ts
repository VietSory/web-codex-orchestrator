import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runControlCommand } from "../src/orchestration/control-cli.js";
import { retryableFailureCode } from "../src/orchestration/retry-policy.js";

test("P16-CLI-001 durable continue accepts an explicit Web verdict input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-cli-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runControlCommand("continue", [
    "--run-id", "invalid-run-id",
    "--state-dir", root,
    "--config", path.join(root, "config.json"),
    "--web-verdict", path.join(root, "verdict.json"),
    "--json",
  ], { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) });
  assert.equal(code, 2);
  assert.equal(stdout.length, 0);
  assert.match(stderr.join("\n"), /ORCHESTRATION_RUN_ID_INVALID/);
  assert.doesNotMatch(stderr.join("\n"), /ORCHESTRATION_CLI_INVALID/);
});

test("P16-CLI-002 Web verdict input is forbidden outside continue", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-cli-scope-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const stderr: string[] = [];
  const code = await runControlCommand("status", [
    "--run-id", `TASK:${"a".repeat(64)}`,
    "--state-dir", root,
    "--web-verdict", path.join(root, "verdict.json"),
  ], { stdout: () => undefined, stderr: (value) => stderr.push(value) });
  assert.equal(code, 2);
  assert.match(stderr.join("\n"), /ORCHESTRATION_CLI_INVALID/);
});

test("P16-OPS-001 common GitHub rate-limit spelling variants remain retryable", () => {
  assert.equal(retryableFailureCode("GITHUB_RATE_LIMIT"), true);
  assert.equal(retryableFailureCode("GITHUB_RATE_LIMITED"), true);
  assert.equal(retryableFailureCode("WEB_REVIEW_RATE_LIMITED"), true);
  assert.equal(retryableFailureCode("ORCHESTRATION_POLICY_BLOCKED"), false);
});
