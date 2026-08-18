import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { chatGptCodexReviewRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const request = {
  run_id: `TASK-REVIEW:${"a".repeat(64)}`,
  result_bundle_sha256: "b".repeat(64),
  published_commit_sha: "c".repeat(40),
  pull_request_url: "https://github.com/example/project/pull/1",
  review_round: 1,
} as const;

function exactFile(content: Buffer, contentRef = false) {
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  return {
    path: "src/caller.ts",
    content_base64: contentRef ? "" : content.toString("base64"),
    ...(contentRef ? { content_ref: `sha256:${digest}` } : {}),
    content_sha256: digest,
    blob_sha: "d".repeat(40),
    size_bytes: content.byteLength,
    start_byte: 0,
    end_byte_exclusive: content.byteLength,
    total_bytes: content.byteLength,
  };
}

test("digest-only review read stays inspection-only until exact source bytes reach the semantic thread", () => {
  const source = Buffer.from("export function caller() { return preserveInvariant(); }\n", "utf8");
  const digestOnlyPrompt = chatGptCodexReviewRepositoryResultPrompt(
    { files: [exactFile(source, true)] },
    request,
    "review-source-delivery",
  );

  assert.match(digestOnlyPrompt, /^WCO_SEMANTIC_PHASE:REVIEW_INSPECTION\n/);
  assert.doesNotMatch(digestOnlyPrompt, /For kind=web_verdict/);
  assert.match(digestOnlyPrompt, /content_ref/);
  assert.doesNotMatch(digestOnlyPrompt, /preserveInvariant/);

  const deliveredSourcePrompt = chatGptCodexReviewRepositoryResultPrompt(
    { files: [exactFile(source)] },
    request,
    "review-source-delivery",
  );

  assert.match(deliveredSourcePrompt, /^WCO_SEMANTIC_PHASE:REVIEW\n/);
  assert.match(deliveredSourcePrompt, /For kind=web_verdict/);
  assert.match(deliveredSourcePrompt, /preserveInvariant/);
  assert.doesNotMatch(deliveredSourcePrompt, /content_base64/);
});
