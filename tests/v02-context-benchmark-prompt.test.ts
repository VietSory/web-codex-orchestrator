import test from "node:test";
import assert from "node:assert/strict";
import { reviewPrompt } from "../src/executor/production-gates.js";
import type { ExecutorReviewRequest } from "../src/executor/gates.js";

const request: ExecutorReviewRequest = {
  run_id: `TASK:${"a".repeat(64)}`,
  artifact_sha256: "b".repeat(64),
  worktree_path: "/tmp/worktree",
  accepted_bundle_path: "/tmp/bundle",
  change_set_digest: "c".repeat(64),
  changed_paths: ["src/change.ts"],
  reviewer: "sol",
  prior_evidence_sha256: [],
  context_selection: {
    schema_version: "1.0",
    source: "bound-project-map-read-coverage",
    changed_paths: ["src/change.ts"],
    paths: ["src/helper.ts"],
    candidate_count: 1,
    truncated: false,
    selection_sha256: "d".repeat(64),
  },
};

test("v0.2 A/B baseline prompt removes smart-context hints without weakening changed-file or authority instructions", () => {
  const baseline = reviewPrompt(request, { smart_context: false });
  const smart = reviewPrompt(request, { smart_context: true });
  assert.doesNotMatch(baseline, /Deterministic context selection/);
  assert.doesNotMatch(baseline, /src\/helper\.ts/);
  assert.match(baseline, /src\/change\.ts/);
  assert.match(baseline, /accepted Task Bundle as the requirement\/acceptance source of truth/i);
  assert.match(baseline, /read-only mode/);
  assert.match(smart, /Deterministic context selection/);
  assert.match(smart, /src\/helper\.ts/);
});
