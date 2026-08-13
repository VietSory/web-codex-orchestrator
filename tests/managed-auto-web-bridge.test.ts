import test from "node:test";
import assert from "node:assert/strict";
import { ManagedAutoWebBridge } from "../src/web-bridge/managed-auto-web-bridge.js";

function fixtures(runStatus: "in_progress" | "completed" | "suspended" | "failed" = "in_progress") {
  const triggered: Array<{ purpose: string; identity: string; input: string; idempotencyKey: string }> = [];
  const relay = {
    createAuthoringJob: async () => ({ job_id: "job-1", owner: "account-a", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z" }),
    waitForAuthoringEvent: async () => null,
    submitRepositoryCommandResult: async () => undefined,
    submitClarification: async () => undefined,
    receiveSealedContract: async () => null,
    receiveWebImplementation: async () => null,
    createFinalReviewJob: async () => ({ job_id: "review-1", owner: "account-a", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z" }),
    submitFinalReviewEvidence: async () => undefined,
    waitForVerdict: async () => null,
    getConnectionStatus: async () => ({ configured: true, connected: true, pending_author_job: null, pending_final_review: null }),
  };
  const managed = {
    triggerAgent: async (value: any) => { triggered.push(value); return { agent_trigger_run_id: `apirun_${value.identity.replace(/[^A-Za-z0-9_-]/g, "_")}`, conversation_url: "https://chatgpt.com/c/test" }; },
    readAgentRun: async (runId: string) => ({ id: runId, status: runStatus, conversation_url: "https://chatgpt.com/c/test", error: runStatus === "failed" ? { code: "fixture", message: "failed" } : null }),
  };
  return { bridge: new ManagedAutoWebBridge(relay as any, managed as any), triggered };
}

test("creating a managed authoring job automatically triggers Web-A with no browser callback", async () => {
  const { bridge, triggered } = fixtures();
  const identity = await bridge.createAuthoringJob({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "Fix bug", ttl_seconds: 600 }, "create-1");
  assert.equal(identity.job_id, "job-1");
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0]!.purpose, "author");
  assert.equal(triggered[0]!.identity, "job-1");
});

test("submitting exact review evidence automatically chooses independent Web-B or final Web-A", async () => {
  const { bridge, triggered } = fixtures();
  await bridge.submitFinalReviewEvidence("review-1", { purpose: "independent_code_review", binding: {} }, "evidence-1");
  await bridge.submitFinalReviewEvidence("review-2", { purpose: "final_intent_review", binding: {} }, "evidence-2");
  assert.deepEqual(triggered.map((value) => [value.purpose, value.identity]), [
    ["independent_code_review", "review-1"],
    ["final_intent_review", "review-2"],
  ]);
});

test("managed agent completion without required semantic output fails closed instead of asking for browser fallback", async () => {
  const { bridge } = fixtures("completed");
  await bridge.createAuthoringJob({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "Fix bug", ttl_seconds: 600 }, "create-1");
  await assert.rejects(bridge.waitForAuthoringEvent("job-1", 0), (error: any) => error?.code === "WEB_MANAGED_AGENT_INCOMPLETE" && /No browser\/manual fallback/.test(error.message));
});

test("managed agent suspension is an operator defect, never an end-user per-task approval step", async () => {
  const { bridge } = fixtures("suspended");
  await bridge.createFinalReviewJob({ run_id: `task:${"b".repeat(64)}`, result_bundle_sha256: "c".repeat(64), published_commit_sha: "d".repeat(40), pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, "review-create");
  await bridge.submitFinalReviewEvidence("review-1", { purpose: "final_intent_review", binding: {} }, "evidence");
  await assert.rejects(bridge.waitForVerdict("review-1"), (error: any) => error?.code === "WEB_MANAGED_OPERATOR_CONFIGURATION_REQUIRED" && /end user must not/.test(error.message));
});