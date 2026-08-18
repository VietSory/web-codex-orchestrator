import assert from "node:assert/strict";
import test from "node:test";
import { chatGptCodexReviewPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };
const publicEvents = [
  { type: "thread.started", timestamp: "2026-01-01T00:00:00.000Z" },
  { type: "turn.started", timestamp: "2026-01-01T00:00:00.001Z" },
  { type: "agent_message", timestamp: "2026-01-01T00:00:00.002Z" },
  { type: "turn.completed", timestamp: "2026-01-01T00:00:00.003Z" },
];

test("local semantic adapter rejects verdict authority returned during inspection-only review even if provider ignores output schema", async () => {
  const reviewRequest = {
    run_id: `TASK-LOCAL-PHASE:${"a".repeat(64)}`,
    result_bundle_sha256: "b".repeat(64),
    published_commit_sha: "c".repeat(40),
    pull_request_url: "https://github.com/example/project/pull/1",
    review_round: 1,
  } as const;
  const prompt = chatGptCodexReviewPrompt(
    reviewRequest,
    { purpose: "independent_code_review", binding: reviewRequest, entries: {} },
    "review-local-phase",
  );
  assert.match(prompt, /^WCO_SEMANTIC_PHASE:REVIEW_INSPECTION\n/);

  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn() {
      return {
        thread_id: "malformed-phase-thread",
        output: {
          protocol_version: "wco-chatgpt-codex-v1",
          kind: "web_verdict",
          payload_json: JSON.stringify({ verdict: "APPROVE" }),
        },
        usage,
        public_events: publicEvents,
      };
    },
  } as any);

  await assert.rejects(
    client.turn({
      profile: { model: "gpt-5.6-sol", reasoning_effort: "high" } as any,
      prompt,
      scratchDirectory: "/tmp/wco-local-phase-scratch",
      authorityDirectory: "/tmp/wco-local-phase-authority",
    }),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_PHASE_OUTPUT_INVALID",
  );
});
