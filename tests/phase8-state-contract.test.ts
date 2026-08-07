import test from "node:test";
import assert from "node:assert/strict";
import { assertRevisionReceipt } from "../src/revision/revision-store.js";
import { RevisionError, type RevisionReceipt } from "../src/revision/contracts.js";

function validReceipt(): RevisionReceipt {
  return {
    phase_version: "1.0",
    run_id: `TASK:${"1".repeat(64)}`,
    revision_round: 1,
    state: "READY_TO_REVISE",
    resume_state: null,
    spec_set_sha256: "2".repeat(64),
    revision_request_sha256: "3".repeat(64),
    previous_result_bundle_sha256: "4".repeat(64),
    previous_result_receipt_sha256: "5".repeat(64),
    previous_verdict_sha256: "6".repeat(64),
    previous_published_commit_sha: "7".repeat(40),
    previous_pr_head_sha: "7".repeat(40),
    pull_request_number: 42,
    branch_name: "codex/feature",
    base_branch: "main",
    worktree_path: "/tmp/worktree",
    initial_refs_sha256: "8".repeat(64),
    implementer: { model: "gpt-5.6", reasoning_effort: "high", thread_id: null, iterations: 0 },
    verification: { rounds: 0, required_commands_passed: false, verified_change_set_sha256: null, commands: [] },
    terra_review: { model: "gpt-5.6", reasoning_effort: "high", rounds: 0, thread_ids: [], verdict: null, reviewed_change_set_sha256: null },
    sol_review: { model: "gpt-5.6", reasoning_effort: "xhigh", rounds: 0, thread_ids: [], verdict: null, reviewed_change_set_sha256: null },
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_turns: 0, implementation_iterations: 0, internal_review_rounds: 0, sol_review_rounds: 0, started_at: "2026-08-07T00:00:00.000Z" },
    revision_change_set_sha256: null,
    revision_paths: [],
    approved_snapshot_sha256: null,
    new_published_commit_sha: null,
    remote_branch_sha: null,
    result_bundle_sha256: null,
    result_manifest_sha256: null,
    next_review_round: 2,
    errors: [],
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
    completed_at: null,
  };
}

test("P8-STATE-001: RETRYABLE requires an exact resumable checkpoint", () => {
  const retryable = { ...validReceipt(), state: "RETRYABLE", resume_state: "VERIFYING" };
  assert.doesNotThrow(() => assertRevisionReceipt(retryable));
  for (const resume_state of [null, "BLOCKED", "FAILED", "RESULT_READY", "RETRYABLE", "UNKNOWN"] as const) {
    assert.throws(
      () => assertRevisionReceipt({ ...retryable, resume_state }),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_INVALID"
    );
  }
});

test("P8-STATE-002: non-RETRYABLE receipt cannot carry a hidden resume state", () => {
  assert.throws(
    () => assertRevisionReceipt({ ...validReceipt(), resume_state: "IMPLEMENTING" }),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_INVALID"
  );
});

test("P8-STATE-003: usage budget cannot be omitted, negative, fractional, or malformed", () => {
  const base = validReceipt();
  assert.throws(() => assertRevisionReceipt({ ...base, usage: undefined }), (error: unknown) => error instanceof RevisionError);
  assert.throws(() => assertRevisionReceipt({ ...base, usage: { ...base.usage, total_turns: -1 } }), (error: unknown) => error instanceof RevisionError);
  assert.throws(() => assertRevisionReceipt({ ...base, usage: { ...base.usage, input_tokens: 1.5 } }), (error: unknown) => error instanceof RevisionError);
  assert.throws(() => assertRevisionReceipt({ ...base, usage: { ...base.usage, started_at: "not-a-date" } }), (error: unknown) => error instanceof RevisionError);
});
