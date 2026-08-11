import test from "node:test";
import assert from "node:assert/strict";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { executeRun } from "../src/execution/execution-service.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import { createPhase4Fixture } from "./helpers/phase4-fixture.js";

function assessment(): unknown {
  return { status: "COMPATIBLE", summary: "compatible", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null };
}

function implementation(): unknown {
  return { status: "READY_FOR_VERIFICATION", summary: "implemented", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null };
}

function approvedReview(request: AgentTurnRequest): unknown {
  const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64);
  return {
    verdict: "APPROVE",
    reviewed_change_set_sha256: digest,
    summary: "approved",
    acceptance_results: [
      { acceptance_id: "AC-001", status: "PASS", evidence: ["fixture"] },
      { acceptance_id: "AC-002", status: "PASS", evidence: ["fixture"] },
    ],
    blocking_findings: [],
    non_blocking_findings: [],
    scope_violations: [],
    unverified_acceptance: [],
    human_action: null,
  };
}

for (const selected of [
  { kind: "sol" as const, model: "gpt-5.6-sol", reasoning_effort: "high" as const },
  { kind: "terra" as const, model: "gpt-5.6-terra", reasoning_effort: "medium" as const },
]) {
  test(`V04-P4-REVIEW-${selected.kind.toUpperCase()} Phase 4 calls exactly the selected ${selected.kind} reviewer`, async () => {
    const fixture = await createPhase4Fixture();
    try {
      const client = new FakeAgentClient([
        assessment(),
        implementation(),
        (request: AgentTurnRequest) => approvedReview(request),
      ]);
      const receipt = await executeRun({
        runId: fixture.runId,
        stateDirectory: fixture.state,
        configPath: fixture.configPath,
        reviewerSelection: selected,
        agentClient: client,
        sandbox: new FakeVerificationSandbox(),
      });

      assert.equal(receipt.state, "READY_FOR_PUBLISH");
      assert.deepEqual(receipt.reviewer_selection, selected);
      const reviewCalls = client.calls.filter((request) => request.role === "reviewer");
      assert.equal(reviewCalls.length, 1);
      assert.equal(reviewCalls[0]?.model, selected.model);
      assert.equal(reviewCalls[0]?.reasoning_effort, selected.reasoning_effort);
      if (selected.kind === "sol") {
        assert.equal(receipt.final_reviewer.verdict, "APPROVE");
        assert.equal(receipt.final_reviewer.rounds, 1);
        assert.equal(receipt.internal_reviewer.rounds, 0);
        assert.equal(receipt.internal_reviewer.verdict, null);
      } else {
        assert.equal(receipt.internal_reviewer.verdict, "APPROVE");
        assert.equal(receipt.internal_reviewer.rounds, 1);
        assert.equal(receipt.final_reviewer.rounds, 0);
        assert.equal(receipt.final_reviewer.verdict, null);
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("V04-P4-REVIEW-REVISE selected Sol REVISE returns to implementer, re-verifies, then reuses Sol only", async () => {
  const fixture = await createPhase4Fixture();
  try {
    let solRound = 0;
    const client = new FakeAgentClient([
      assessment(),
      implementation(),
      (request: AgentTurnRequest) => {
        solRound += 1;
        const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64);
        return {
          ...(approvedReview(request) as Record<string, unknown>),
          verdict: "REVISE",
          reviewed_change_set_sha256: digest,
          blocking_findings: [{ id: "FIX-001", severity: "high", category: "correctness", file: "README.md", line_start: 1, line_end: 1, acceptance_ids: ["AC-001"], problem: "fixture finding", evidence: "fixture", required_fix: "fix" }],
        };
      },
      implementation(),
      (request: AgentTurnRequest) => { solRound += 1; return approvedReview(request); },
    ]);
    const receipt = await executeRun({
      runId: fixture.runId,
      stateDirectory: fixture.state,
      configPath: fixture.configPath,
      reviewerSelection: { kind: "sol", model: "gpt-5.6-sol", reasoning_effort: "high" },
      agentClient: client,
      sandbox: new FakeVerificationSandbox(),
    });
    assert.equal(receipt.state, "READY_FOR_PUBLISH");
    assert.equal(solRound, 2);
    assert.equal(receipt.final_reviewer.rounds, 2);
    assert.equal(receipt.final_reviewer.verdict, "APPROVE");
    assert.equal(receipt.internal_reviewer.rounds, 0);
    assert.equal(receipt.internal_reviewer.verdict, null);
    const reviewCalls = client.calls.filter((request) => request.role === "reviewer");
    assert.equal(reviewCalls.length, 2);
    assert.ok(reviewCalls.every((request) => request.model === "gpt-5.6-sol"));
  } finally {
    await fixture.cleanup();
  }
});
