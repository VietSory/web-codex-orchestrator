import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CHATGPT_CODEX_AUTHOR_CONTEXT_KINDS } from "../src/web-bridge/chatgpt-codex-output-schema.js";
import { chatGptCodexRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const request = {
  owner: "local-test",
  repository: { repository_id: "author-context-recovery", base_branch: "main", base_commit: "a".repeat(40) },
  user_intent: "Understand the repository exactly before sealing.",
  ttl_seconds: 300,
} as const;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("normal author repository follow-up renders nested exact source as readable UTF-8", () => {
  const source = Buffer.from("export function caller() { return preserveInvariant(); }\n", "utf8");
  const prompt = chatGptCodexRepositoryResultPrompt({
    request_id: "repo-author-readable",
    result: {
      files: [{
        path: "src/caller.ts",
        content_base64: source.toString("base64"),
        content_sha256: digest(source),
        blob_sha: "b".repeat(40),
        size_bytes: source.byteLength,
        start_byte: 0,
        end_byte_exclusive: source.byteLength,
        total_bytes: source.byteLength,
      }],
    },
  }, request, "author-context-recovery");

  assert.match(prompt, /^WCO_SEMANTIC_PHASE:AUTHOR\n/);
  assert.match(prompt, /preserveInvariant/);
  assert.match(prompt, /"content_utf8":/);
  assert.doesNotMatch(prompt, /"content_base64":/);
});

test("oversized author repository result becomes context-only digest receipt instead of wedging or allowing seal", () => {
  const result = {
    request_id: "repo-author-oversize",
    result: {
      paths: Array.from({ length: 5_000 }, (_, index) => `src/generated/${String(index).padStart(4, "0")}-${"x".repeat(96)}.ts`),
      truncated: false,
    },
  };

  const prompt = chatGptCodexRepositoryResultPrompt(result, request, "author-context-recovery");

  assert.match(prompt, /^WCO_SEMANTIC_PHASE:AUTHOR_CONTEXT\n/);
  assert.match(prompt, /"repository_result_oversized":true/);
  assert.match(prompt, /"exact_result_sha256":"[a-f0-9]{64}"/);
  assert.match(prompt, /This receipt is not repository evidence and cannot justify sealing a contract/);
  assert.match(prompt, /Return repository_command only/);
  assert.deepEqual(CHATGPT_CODEX_AUTHOR_CONTEXT_KINDS, ["repository_command"]);
  assert.ok(Buffer.byteLength(prompt, "utf8") < 64_000, "author oversize recovery receipt should remain small and resumable");
});
