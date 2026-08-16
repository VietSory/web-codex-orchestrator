import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentLimits } from "../src/config/contracts.js";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { CHATGPT_CODEX_CHALLENGE_PAYLOAD_MAX_CHARS } from "../src/web-bridge/chatgpt-codex-output-schema.js";
import { ChatGptCodexSemanticChallengeTransport } from "../src/web-bridge/chatgpt-codex-semantic-challenge-transport.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const limits: AgentLimits = {
  maximum_implementation_iterations: 4,
  maximum_internal_review_rounds: 2,
  maximum_sol_review_rounds: 2,
  maximum_total_agent_turns: 8,
  maximum_turn_seconds: 60,
  maximum_total_seconds: 600,
  maximum_total_input_tokens: 100_000,
  maximum_total_output_tokens: 20_000,
};
const cleanEvents = [
  { type: "thread.started", timestamp: "2026-08-16T10:00:00.000Z" },
  { type: "turn.started", timestamp: "2026-08-16T10:00:00.001Z" },
  { type: "agent_message", timestamp: "2026-08-16T10:00:00.002Z" },
  { type: "turn.completed", timestamp: "2026-08-16T10:00:00.003Z" },
];

test("challenge schema and local parser both bound provider payload_json", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wco-challenge-payload-bound-"));
  const scratchDirectory = path.join(root, "scratch");
  const authorityDirectory = path.join(root, "authority");
  mkdirSync(scratchDirectory, { mode: 0o700 });
  mkdirSync(authorityDirectory, { mode: 0o700 });
  let calls = 0;
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn(turn: any) {
      calls += 1;
      assert.equal(turn.output_schema.properties.payload_json.maxLength, CHATGPT_CODEX_CHALLENGE_PAYLOAD_MAX_CHARS);
      return {
        thread_id: "oversized-challenge-thread",
        output: {
          protocol_version: "wco-chatgpt-codex-v1",
          kind: "repository_command",
          payload_json: "x".repeat(CHATGPT_CODEX_CHALLENGE_PAYLOAD_MAX_CHARS + 1),
        },
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        public_events: cleanEvents,
      };
    },
  } as any, 60);
  const transport = new ChatGptCodexSemanticChallengeTransport({
    client,
    profile: { model: "gpt-5.6-sol", reasoning_effort: "high" } as any,
    limits,
    scratchDirectory,
    authorityDirectory,
    now: () => new Date("2026-08-16T10:00:00.000Z"),
  });
  const request = createSemanticChallengeRequest({
    challengeId: "oversized-provider-payload",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    originalGoal: "Bound provider output before JSON parsing.",
  });
  const identity = await transport.createSemanticChallengeJob(request, "oversized-provider-payload");
  await assert.rejects(transport.waitForSemanticChallengeAction(identity.job_id, 0), /payload_json exceeds its bounded size/i);
  await assert.rejects(transport.waitForSemanticChallengeAction(identity.job_id, 0), /ambiguous and cannot be replayed/i);
  assert.equal(calls, 1);
});
