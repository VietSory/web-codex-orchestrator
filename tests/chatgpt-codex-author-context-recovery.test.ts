import assert from "node:assert/strict";
import test from "node:test";
import { CHATGPT_CODEX_AUTHOR_CONTEXT_KINDS } from "../src/web-bridge/chatgpt-codex-output-schema.js";
import { chatGptCodexRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const request = {
  owner: "local-test",
  repository: { repository_id: "author-context-recovery", base_branch: "main", base_commit: "a".repeat(40) },
  user_intent: "Understand the repository exactly before sealing.",
  ttl_seconds: 300,
} as const;

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
