import test from "node:test";
import assert from "node:assert/strict";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../src/agent/contracts.js";
import { reviewWithSol } from "../src/agent/sol-reviewer.js";
import { reviewWithTerra } from "../src/agent/terra-reviewer.js";

const DIGEST = "a".repeat(64);
const APPROVAL = {
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
};

class CaptureClient implements AgentClient {
  readonly requests: AgentTurnRequest[] = [];
  constructor(private readonly output: unknown = APPROVAL) {}

  async checkAvailability(): Promise<void> {}

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.requests.push(request);
    return { thread_id: `review-thread-${this.requests.length}`, output: this.output };
  }
}

const request = {
  model: "review-model",
  reasoning_effort: "high" as const,
  prompt: `Base commit: ${"b".repeat(40)}\nChange-set digest: ${DIGEST}\nBounded tracked diff:\n@@ -1 +1 @@\n-old\n+new\nDeterministic verification evidence: PASS`,
  threadId: undefined,
  workspacePath: "/tmp/wco-reviewer-policy-test-workspace-that-must-not-exist",
  acceptedBundlePath: "/tmp/review-bundle",
  changedPaths: [] as string[],
};

function finding(file: string) {
  return {
    id: "FINDING-1",
    severity: "medium",
    category: "maintainability",
    file,
    line_start: 1,
    line_end: 1,
    acceptance_ids: [],
    problem: "Concrete review evidence must resolve to the exact worktree or a deleted diff path.",
    evidence: `${file}:1`,
    required_fix: "Use exact review evidence.",
  };
}

function assertSeniorPolicy(prompt: string): void {
  assert.match(prompt, /senior maintainer performing an adversarial pull-request review/i);
  assert.match(prompt, /verification passing is a prerequisite.*not proof/i);
  assert.match(prompt, /complete diff against the supplied base commit/i);
  assert.match(prompt, /every changed file and every diff hunk/i);
  assert.match(prompt, /concurrency, races, retries, replay and idempotency/i);
  assert.match(prompt, /crash\/restart recovery and stale state/i);
  assert.match(prompt, /Do not trust implementation claims.*green test suite as correctness evidence/i);
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

test("reviewer approval is rejected when its own structured evidence contains a blocker", async () => {
  const client = new CaptureClient({
    ...APPROVAL,
    blocking_findings: [{
      ...finding("src/example.ts"),
      id: "BLOCK-1",
      severity: "high",
      category: "correctness",
      problem: "The patch can return the wrong result.",
      required_fix: "Correct the branch before approval.",
    }],
  });
  await assert.rejects(reviewWithSol(client, request), /APPROVE cannot carry blocking findings/);
});

test("reviewer approval is rejected when reported acceptance is failed or unverified", async () => {
  const client = new CaptureClient({
    ...APPROVAL,
    acceptance_results: [{ acceptance_id: "AC-1", status: "FAIL", evidence: ["tests/example.test.ts:1"] }],
  });
  await assert.rejects(reviewWithTerra(client, request), /APPROVE requires all reported acceptance evidence to be PASS/);
});

test("review findings cannot cite an invented path outside the exact changed set", async () => {
  const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding("src/does-not-exist.ts")] });
  await assert.rejects(reviewWithSol(client, request), /does not exist and is not an exact changed\/deleted path/);
});

test("a finding may cite an exact deleted diff path that is absent from the post-change worktree", async () => {
  const deletedPath = "src/deleted.ts";
  const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding(deletedPath)] });
  const result = await reviewWithTerra(client, { ...request, changedPaths: [deletedPath] });
  assert.equal(result.review.non_blocking_findings[0]!.file, deletedPath);
});
