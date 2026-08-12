import test from "node:test";
import assert from "node:assert/strict";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../src/agent/contracts.js";
import { reviewWithSol } from "../src/agent/sol-reviewer.js";
import { reviewWithTerra } from "../src/agent/terra-reviewer.js";

const DIGEST = "a".repeat(64);

class CaptureClient implements AgentClient {
  readonly requests: AgentTurnRequest[] = [];

  async checkAvailability(): Promise<void> {}

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.requests.push(request);
    return {
      thread_id: `review-thread-${this.requests.length}`,
      output: {
        verdict: "APPROVE",
        reviewed_change_set_sha256: DIGEST,
        summary: "No blocking defect found after adversarial diff review.",
        acceptance_results: [],
        blocking_findings: [],
        non_blocking_findings: [],
        scope_violations: [],
        unverified_acceptance: [],
        human_action: null,
        repair_operations: [],
      },
    };
  }
}

const request = {
  model: "review-model",
  reasoning_effort: "high" as const,
  prompt: `Base commit: ${"b".repeat(40)}\nChange-set digest: ${DIGEST}\nBounded tracked diff:\n@@ -1 +1 @@\n-old\n+new\nDeterministic verification evidence: PASS`,
  threadId: undefined,
  workspacePath: "/tmp/review-workspace",
  acceptedBundlePath: "/tmp/review-bundle",
};

function assertSeniorPolicy(prompt: string): void {
  assert.match(prompt, /senior maintainer performing an adversarial pull-request review/i);
  assert.match(prompt, /verification passing is a prerequisite.*not proof/i);
  assert.match(prompt, /complete diff against the supplied base commit/i);
  assert.match(prompt, /every changed file and every diff hunk/i);
  assert.match(prompt, /concurrency, races, retries, replay and idempotency/i);
  assert.match(prompt, /crash\/restart recovery and stale state/i);
  assert.match(prompt, /green test suite.*not.*correctness evidence/i);
  assert.match(prompt, /APPROVE only after the complete diff has been inspected/i);
  assert.match(prompt, /repair_operations in the same response/i);
  assert.match(prompt, /If the complete diff cannot be inspected.*do not APPROVE/i);
}

test("selected Sol reviewer receives senior adversarial diff-review policy", async () => {
  const client = new CaptureClient();
  await reviewWithSol(client, request);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]!.read_only, true);
  assert.equal(client.requests[0]!.sandbox_mode, "read-only");
  assertSeniorPolicy(client.requests[0]!.prompt);
});

test("selected Terra reviewer receives the same senior adversarial diff-review policy", async () => {
  const client = new CaptureClient();
  await reviewWithTerra(client, request);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]!.read_only, true);
  assert.equal(client.requests[0]!.sandbox_mode, "read-only");
  assertSeniorPolicy(client.requests[0]!.prompt);
});
