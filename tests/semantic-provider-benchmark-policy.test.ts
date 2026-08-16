import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertPromptOnlySemanticBenchmarkTurn } from "../src/benchmark/semantic-provider-event-policy.js";
import { createSemanticChallengeRequest, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";

test("provider benchmark challenger derives its reasoning policy from the runtime blind-challenge prompt", async () => {
  const source = await readFile(path.resolve("scripts/benchmark-semantic-provider.mts"), "utf8");
  assert.match(source, /createSemanticChallengeRequest, semanticChallengePrompt/);
  assert.equal(source.includes("MAINTAINER_REVIEW_STANDARD"), false, "benchmark must not substitute the final-review policy for the runtime blind challenger");
  assert.match(source, /runtime_semanticChallengePrompt_core/);

  const probe = createSemanticChallengeRequest({
    challengeId: "benchmark-policy-probe",
    repository: { repository_id: "benchmark-policy-probe", base_branch: "main", base_commit: "0".repeat(40) },
    originalGoal: "Benchmark policy probe only.",
  });
  const runtime = semanticChallengePrompt(probe);
  for (const text of [
    "You are an independent senior-maintainer semantic challenger.",
    "You have intentionally NOT been shown Web-A's candidate contract",
    "Your task is to independently determine what the repository currently does",
    "Trace relevant callers/callees and state/authority boundaries",
    "Challenge unsupported assumptions.",
  ]) assert.match(runtime, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("provider benchmark accepts only prompt-only lifecycle events", () => {
  assert.doesNotThrow(() => assertPromptOnlySemanticBenchmarkTurn([
    { type: "thread.started" },
    { type: "turn.started" },
    { type: "reasoning" },
    { type: "todo_list" },
    { type: "agent_message" },
    { type: "turn.completed" },
  ]));

  for (const forbidden of ["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call", "error", "unknown_tool"]) {
    assert.throws(() => assertPromptOnlySemanticBenchmarkTurn([
      { type: "thread.started" },
      { type: "turn.started" },
      { type: forbidden },
      { type: "agent_message" },
      { type: "turn.completed" },
    ]), /forbidden provider tool\/event/i);
  }
});

test("provider benchmark fails closed when the event audit is missing, ambiguous, or may be truncated", () => {
  assert.throws(() => assertPromptOnlySemanticBenchmarkTurn(undefined), /missing the provider public event audit trail/i);
  assert.throws(() => assertPromptOnlySemanticBenchmarkTurn([{ type: "thread.started" }, { type: "agent_message" }]), /lifecycle is incomplete or ambiguous/i);
  assert.throws(
    () => assertPromptOnlySemanticBenchmarkTurn(Array.from({ length: 256 }, (_, index) => ({ type: index === 0 ? "thread.started" : "reasoning" }))),
    /truncation bound/i,
  );
});

test("provider benchmark audit bound and item visibility stay aligned with CodexSdkAgentClient", async () => {
  const source = await readFile(path.resolve("src/agent/codex-sdk-client.ts"), "utf8");
  assert.match(source, /const MAX_PUBLIC_EVENTS = 256;/);
  assert.match(source, /case "item\.completed"[\s\S]*recordEvent\(event\.item\.type\)/);
  assert.match(source, /case "item\.started"[\s\S]*case "item\.updated"[\s\S]*recordEvent\(event\.item\.type\)/);
});

test("provider benchmark runner enforces the prompt-only event audit before accepting output", async () => {
  const source = await readFile(path.resolve("scripts/benchmark-semantic-provider.mts"), "utf8");
  assert.match(source, /assertPromptOnlySemanticBenchmarkTurn\(response\.public_events\)/);
  assert.match(source, /provider_local_tool_activity: "rejected_if_observed_or_event_audit_truncated"/);
  assert.equal(source.includes("hidden_gold_exposed_to_provider"), false, "runner must not overclaim filesystem inaccessibility from read-only sandbox mode");
});
