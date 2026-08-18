import assert from "node:assert/strict";
import test from "node:test";
import { withFinalReviewNotification } from "../src/tui/autopilot-web-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity } from "../src/web-bridge/contracts.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";

function identity(jobId: string): BridgeJobIdentity {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    owner: "local",
    created_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-02T00:00:00.000Z",
    content_sha256: "a".repeat(64),
  };
}

function bridgeFixture(preflight?: (evidence: Record<string, unknown>) => Promise<void>): WebBridge {
  return {
    async createAuthoringJob() { return identity("author-1"); },
    async waitForAuthoringEvent() { return null; },
    async submitRepositoryCommandResult() {},
    async submitClarification() {},
    async receiveSealedContract() { return null; },
    async receiveWebImplementation() { return null; },
    ...(preflight ? { preflightFinalReviewEvidence: preflight } : {}),
    async createFinalReviewJob() { return identity("review-1"); },
    async submitFinalReviewEvidence() {},
    async waitForVerdict() { return null; },
    async getConnectionStatus() { return { configured: true, connected: true }; },
  };
}

test("AUTOPILOT notification wrapper preserves provider-specific review preflight", async () => {
  const calls: Record<string, unknown>[] = [];
  const wrapped = withFinalReviewNotification(
    bridgeFixture(async (evidence) => { calls.push(evidence); }),
    async () => undefined,
  );
  const evidence = { purpose: "final_intent_review", exact: true };

  assert.equal(typeof wrapped.preflightFinalReviewEvidence, "function");
  await wrapped.preflightFinalReviewEvidence!(evidence);
  assert.deepEqual(calls, [evidence]);
});

test("AUTOPILOT notification wrapper does not invent an unsupported preflight capability", () => {
  const wrapped = withFinalReviewNotification(bridgeFixture(), async () => undefined);
  assert.equal(wrapped.preflightFinalReviewEvidence, undefined);
});
