import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runControlCommand } from "../src/orchestration/control-cli.js";
import { checkpointAttempt, failAttempt } from "../src/orchestration/controller.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import { retryableFailureCode } from "../src/orchestration/retry-policy.js";
import { runNextTransition } from "../src/orchestration/transition-runner.js";

const HASH = "a".repeat(64);

function registerSnapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: null,
    executor_state: null,
    publish_state: null,
    draft_pr_state: null,
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

function webVerdictSnapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: HASH,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

async function createRetryBackoff(options: {
  root: string;
  runId: string;
  transition: "REGISTER_WEB_PACK" | "WAIT_WEB_VERDICT";
  now: Date;
}): Promise<void> {
  const started = await checkpointAttempt({
    stateDirectory: options.root,
    runId: options.runId,
    transition: options.transition,
    payload: options.transition === "REGISTER_WEB_PACK"
      ? { archive_sha256: HASH, pack_id: "P16-BACKOFF" }
      : { verdict_sha256: HASH },
    now: options.now,
  });
  await failAttempt({
    stateDirectory: options.root,
    runId: options.runId,
    attemptId: started.current_attempt!.attempt_id,
    failureCode: "MODEL_TIMEOUT",
    message: "retry later",
    now: options.now,
  });
}

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
    "--run-id", `TASK:${HASH}`,
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

test("P16-OPS-002 retry backoff returns before re-reading a Web implementation pack", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-pack-backoff-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-PACK:${HASH}`;
  const startedAt = new Date("2026-08-08T00:00:00.000Z");
  await createRetryBackoff({ root, runId, transition: "REGISTER_WEB_PACK", now: startedAt });
  let reads = 0;
  const result = await runNextTransition({
    runId,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { web_pack_path: path.join(root, "untrusted-pack.zip") },
    now: () => new Date("2026-08-08T00:00:00.010Z"),
    dependencies: {
      async readSnapshot() { return registerSnapshot(); },
      async readPack() {
        reads += 1;
        throw new Error("pack should not be read during backoff");
      },
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "REGISTER_WEB_PACK");
  assert.equal(result.needs_input, null);
  assert.ok(result.ledger.retry.next_retry_at);
});

test("P16-OPS-003 retry backoff returns before canonicalizing a Web verdict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-verdict-backoff-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-VERDICT:${HASH}`;
  const startedAt = new Date("2026-08-08T00:00:00.000Z");
  await createRetryBackoff({ root, runId, transition: "WAIT_WEB_VERDICT", now: startedAt });
  let reads = 0;
  const result = await runNextTransition({
    runId,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { web_verdict_path: path.join(root, "untrusted-verdict.json") },
    now: () => new Date("2026-08-08T00:00:00.010Z"),
    dependencies: {
      async readSnapshot() { return webVerdictSnapshot(); },
      async readVerdict() {
        reads += 1;
        throw new Error("verdict should not be read during backoff");
      },
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.needs_input, null);
  assert.ok(result.ledger.retry.next_retry_at);
});
