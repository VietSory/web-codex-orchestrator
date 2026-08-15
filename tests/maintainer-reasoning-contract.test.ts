import assert from "node:assert/strict";
import test from "node:test";
import { SENIOR_DIFF_REVIEW_INSTRUCTION } from "../src/agent/reviewer-policy.js";
import { chatGptCodexAuthorPrompt, chatGptCodexReviewPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const authorRequest = {
  owner: "local",
  repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
  user_intent: "fix a cross-module recovery race without changing public behavior",
  ttl_seconds: 60,
} as const;

const reviewRequest = {
  run_id: `TASK:${"b".repeat(64)}`,
  result_bundle_sha256: "c".repeat(64),
  published_commit_sha: "d".repeat(40),
  pull_request_url: "https://github.com/example/repo/pull/1",
  review_round: 1,
} as const;

function assertMaintainerReviewSemantics(prompt: string): void {
  assert.match(prompt, /green test suite|verification passing/i);
  assert.match(prompt, /not proof/i);
  assert.match(prompt, /concurrency|races/i);
  assert.match(prompt, /retry|replay|idempotency/i);
  assert.match(prompt, /crash\/restart recovery|crash.*restart/i);
  assert.match(prompt, /security.*authority|authority boundaries/i);
  assert.match(prompt, /performance.*resource|performance and resource/i);
  assert.match(prompt, /negative/i);
  assert.match(prompt, /blast radius|surrounding code|callers/i);
  assert.match(prompt, /do not APPROVE|APPROVE only/i);
}

test("normal Web-A authoring is evidence-first and cannot seal on green tests or unsupported assumptions", () => {
  const prompt = chatGptCodexAuthorPrompt(authorRequest, "job-maintainer");
  assert.match(prompt, /skeptical senior maintainer/i);
  assert.match(prompt, /Repository evidence outranks intuition/i);
  assert.match(prompt, /callers, state transitions, persisted state, tests, compatibility surfaces/i);
  assert.match(prompt, /concurrency\/races/i);
  assert.match(prompt, /retry\/replay\/idempotency/i);
  assert.match(prompt, /crash\/restart recovery/i);
  assert.match(prompt, /performance\/resource behavior/i);
  assert.match(prompt, /Separate observed facts from assumptions/i);
  assert.match(prompt, /Passing existing tests.*evidence only/i);
  assert.match(prompt, /do not prove.*correctly understood/i);
  assert.match(prompt, /Seal a contract only when.*no unresolved material ambiguity remains/i);
});

test("normal Web-B/final Web review and Sol/Terra review share maintainer-grade failure analysis", () => {
  const webReview = chatGptCodexReviewPrompt(reviewRequest, { purpose: "independent_code_review", exact: true }, "review-maintainer");
  assertMaintainerReviewSemantics(webReview);
  assertMaintainerReviewSemantics(SENIOR_DIFF_REVIEW_INSTRUCTION);
  assert.match(webReview, /independently derive correctness.*instead of inheriting the author's conclusions/i);
  assert.match(webReview, /final_intent_review.*re-check the final result against the original user intent/i);
  assert.match(SENIOR_DIFF_REVIEW_INSTRUCTION, /every changed file and every diff hunk/i);
  assert.match(SENIOR_DIFF_REVIEW_INSTRUCTION, /If the complete diff cannot be inspected.*do not APPROVE/i);
});

test("maintainer-grade Web review treats missing exact evidence as a fail-closed review condition", () => {
  const prompt = chatGptCodexReviewPrompt(reviewRequest, { purpose: "final_intent_review", exact: false }, "review-evidence");
  assert.match(prompt, /If exact evidence is insufficient to resolve a material question, do not APPROVE/i);
  assert.match(prompt, /use only an available non-approval outcome appropriate to the current phase/i);
  assert.match(prompt, /green test suite.*never as proof/i);
});
