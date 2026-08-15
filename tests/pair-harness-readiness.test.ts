import assert from "node:assert/strict";
import test from "node:test";
import { assertPairHarnessReadyForCodeReview } from "../src/orchestration/pair-harness.js";

const snapshot = (resultBundleReady: boolean): any => ({
  registered_artifact_sha256: "a".repeat(64),
  executor_state: "READY_FOR_PUBLISH",
  publish_state: resultBundleReady ? "PUSHED" : null,
  draft_pr_state: resultBundleReady ? "OPEN" : null,
  result_bundle_ready: resultBundleReady,
  web_review_state: null,
  revision_state: null,
  revision_result_ready: false,
});

test("PAIR never starts independent code review after a blocked Harness transition", () => {
  const diagnostic = { code: "EXECUTOR_CANONICAL_AUTHORITY_DRIFT", message: "exact publish authority drift", count: 1, first_at: "2026-08-15T00:00:00.000Z", last_at: "2026-08-15T00:00:00.000Z" };
  const last = { ledger: { diagnostics: [diagnostic] } } as any;
  assert.throws(
    () => assertPairHarnessReadyForCodeReview(last, snapshot(false)),
    (error: any) => error?.code === diagnostic.code && error?.message === diagnostic.message,
  );
});

test("PAIR starts independent code review only with an exact Result Bundle", () => {
  assert.doesNotThrow(() => assertPairHarnessReadyForCodeReview(null, snapshot(true)));
});
