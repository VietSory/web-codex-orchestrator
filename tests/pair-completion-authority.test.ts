import assert from "node:assert/strict";
import test from "node:test";
import { pairSessionCanComplete } from "../src/tui/pair-completion.js";

const ready = {
  registered_artifact_sha256: "a".repeat(64),
  executor_state: "READY_FOR_PUBLISH",
  publish_state: "PUSHED",
  draft_pr_state: "OPEN",
  result_bundle_ready: true,
  web_code_review_state: "APPROVED" as const,
  web_review_state: "APPROVED" as const,
  revision_state: null,
  revision_result_ready: false,
};

test("PAIR completion requires both current independent code review and final Web approval", () => {
  assert.equal(pairSessionCanComplete(ready), true);
  assert.equal(pairSessionCanComplete({ ...ready, web_code_review_state: null }), false);
  assert.equal(pairSessionCanComplete({ ...ready, web_code_review_state: "REVISION_REQUESTED" }), false);
  assert.equal(pairSessionCanComplete({ ...ready, web_review_state: null }), false);
});
