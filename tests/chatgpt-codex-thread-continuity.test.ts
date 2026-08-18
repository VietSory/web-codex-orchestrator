import assert from "node:assert/strict";
import test from "node:test";
import { chatGptCodexReviewRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const events = [
  { type: "turn.started", timestamp: "2026-08-18T00:00:00.000Z" },
  { type: "agent_message", timestamp: "2026-08-18T00:00:00.001Z" },
  { type: "turn.completed", timestamp: "2026-08-18T00:00:00.002Z" },
];

test("semantic review continuation fails closed when provider thread identity drifts", async () => {
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn(request: any) {
      assert.equal(request.thread_id, "review-thread-original");
      return {
        thread_id: "review-thread-drifted",
        output: { protocol_version: "wco-chatgpt-codex-v1", kind: "web_verdict", payload_json: "{}" },
        usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
        public_events: events,
      };
    },
  } as any);
  const request = {
    run_id: `TASK:${"a".repeat(64)}`,
    result_bundle_sha256: "b".repeat(64),
    published_commit_sha: "c".repeat(40),
    pull_request_url: "https://github.com/example/repo/pull/1",
    review_round: 1,
  } as const;
  await assert.rejects(
    client.turn({
      profile: { model: "gpt-5.6-sol", reasoning_effort: "high" } as any,
      prompt: chatGptCodexReviewRepositoryResultPrompt({ exact: true }, request, "review-id"),
      scratchDirectory: "/tmp/wco-thread-drift-scratch",
      authorityDirectory: "/tmp/wco-thread-drift-authority",
      threadId: "review-thread-original",
    }),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_THREAD_DRIFT",
  );
});
