import assert from "node:assert/strict";
import test from "node:test";
import { chatGptCodexReviewRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const request = {
  run_id: `TASK-OVERSIZE:${"a".repeat(64)}`,
  result_bundle_sha256: "b".repeat(64),
  published_commit_sha: "c".repeat(40),
  pull_request_url: "https://github.com/example/project/pull/1",
  review_round: 1,
} as const;

test("oversized durable review lookup degrades to a digest-bound retry receipt instead of wedging resume", () => {
  const paths = Array.from({ length: 2_500 }, (_, index) => `src/generated/${String(index).padStart(4, "0")}-${"x".repeat(96)}.ts`);
  const exactResult = { paths, truncated: false };

  const prompt = chatGptCodexReviewRepositoryResultPrompt(exactResult, request, "review-oversize", false);

  assert.match(prompt, /^WCO_SEMANTIC_PHASE:REVIEW_INSPECTION\n/);
  assert.match(prompt, /"repository_result_oversized":true/);
  assert.match(prompt, /"exact_result_sha256":"[a-f0-9]{64}"/);
  assert.match(prompt, /"exact_result_json_bytes":\d+/);
  assert.match(prompt, /Request fewer paths, a narrower tree\/search, or smaller exact read regions/);
  assert.doesNotMatch(prompt, /For kind=web_verdict/);
  assert.doesNotMatch(prompt, new RegExp(paths.at(-1)!));
  assert.ok(Buffer.byteLength(prompt, "utf8") < 64_000, "oversize recovery receipt should stay small enough to let the same review thread continue");
});
