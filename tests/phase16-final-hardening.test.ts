import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitHubRestPullRequestClient, parseGitHubRetryAfterMs } from "../src/pull-request/github-rest-client.js";
import { DraftPullRequestError } from "../src/pull-request/contracts.js";
import { checkpointAttempt, failAttempt } from "../src/orchestration/controller.js";
import { runControlCommand } from "../src/orchestration/control-cli.js";
import { writeRunLedger } from "../src/orchestration/ledger.js";
import { retryableFailureCode } from "../src/orchestration/retry-policy.js";

const RUN_ID = `TASK-P16:${"a".repeat(64)}`;

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
    "--run-id", RUN_ID,
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

test("P16-OPS-002 primary GitHub reset may extend Retry-After only when primary quota is exhausted", () => {
  const now = Date.parse("2026-08-08T00:00:00.000Z");
  const headers = new Headers({
    "retry-after": "5",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(Math.floor(now / 1000) + 10),
  });
  assert.equal(parseGitHubRetryAfterMs(headers, now), 10_000);
});

test("P16-OPS-003 durable retry never runs before a bounded server hint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-retry-floor-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "OPEN_DRAFT_PR",
    payload: { head: "3".repeat(40) },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  const failed = await failAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    attemptId: started.current_attempt!.attempt_id,
    failureCode: "PR_API_RATE_LIMITED",
    message: "rate limited",
    minimumRetryDelayMs: 5_000,
    now: new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(failed.status, "WAITING");
  assert.equal(failed.retry.next_retry_at, "2026-08-08T00:00:06.000Z");
});

test("P16-OPS-004 a server retry hint beyond remaining elapsed budget blocks instead of sleeping past budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-retry-budget-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "OPEN_DRAFT_PR",
    payload: { head: "4".repeat(40) },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  started.budget.max_elapsed_ms = 2_000;
  await writeRunLedger(root, started);
  const failed = await failAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    attemptId: started.current_attempt!.attempt_id,
    failureCode: "PR_API_RATE_LIMITED",
    message: "rate limited",
    minimumRetryDelayMs: 5_000,
    now: new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(failed.status, "BLOCKED");
  assert.equal(failed.retry.next_retry_at, null);
});

test("P16-OPS-005 GitHub response body is rejected at the 1 MiB hard cap", async () => {
  const fakeFetch = (async () => new Response(Buffer.alloc(1_048_577, 0x61), { status: 200 })) as unknown as typeof fetch;
  const client = new GitHubRestPullRequestClient("token-value", fakeFetch);
  await assert.rejects(
    () => client.listByHead({ owner: "o", repository: "r", headOwner: "o", headBranch: "b" }),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_API_RESPONSE_TOO_LARGE",
  );
});

test("P16-OPS-006 secondary GitHub rate limit without headers gets the documented one-minute retry floor", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
    status: 403,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const client = new GitHubRestPullRequestClient("token-value", fakeFetch);
  await assert.rejects(
    () => client.listByHead({ owner: "o", repository: "r", headOwner: "o", headBranch: "b" }),
    (error: unknown) => error instanceof DraftPullRequestError
      && error.code === "PR_API_RATE_LIMITED"
      && error.retryAfterMs === 60_000,
  );
});

test("P16-OPS-007 ordinary GitHub 403 remains terminal and is not mistaken for a rate limit", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const client = new GitHubRestPullRequestClient("token-value", fakeFetch);
  await assert.rejects(
    () => client.listByHead({ owner: "o", repository: "r", headOwner: "o", headBranch: "b" }),
    (error: unknown) => error instanceof DraftPullRequestError
      && error.code === "PR_API_FORBIDDEN"
      && error.retryAfterMs === null,
  );
});

test("P16-OPS-008 secondary Retry-After ignores unrelated primary reset while primary quota remains", () => {
  const now = Date.parse("2026-08-08T00:00:00.000Z");
  const headers = new Headers({
    "retry-after": "5",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600),
  });
  assert.equal(parseGitHubRetryAfterMs(headers, now), 5_000);
});

test("P16-OPS-009 local retry backoff beyond remaining elapsed budget blocks immediately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-local-retry-budget-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "OPEN_DRAFT_PR",
    payload: { head: "5".repeat(40) },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  started.budget.max_elapsed_ms = 1_001;
  await writeRunLedger(root, started);
  const failed = await failAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    attemptId: started.current_attempt!.attempt_id,
    failureCode: "NETWORK_UNAVAILABLE",
    message: "temporary network outage",
    now: new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(failed.status, "BLOCKED");
  assert.equal(failed.retry.next_retry_at, null);
});
