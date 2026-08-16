import assert from "node:assert/strict";
import test from "node:test";
import type { AgentLimits } from "../src/config/contracts.js";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { ChatGptCodexSemanticChallengeTransport } from "../src/web-bridge/chatgpt-codex-semantic-challenge-transport.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const profile: any = { model: "gpt-5.6-sol", reasoning_effort: "high" };
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
const request = createSemanticChallengeRequest({
  challengeId: "provider-transport-test",
  repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
  originalGoal: "Understand the repository independently before any implementation authority exists.",
});
const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };

function sealed() {
  return {
    schema_version: "1.0",
    kind: "semantic_understanding_sealed",
    challenge_id: request.challenge_id,
    repository: request.repository,
    original_goal_sha256: "b".repeat(64),
    findings: [],
    unresolved_questions: [],
  };
}

function provider(kind: "repository_command" | "semantic_understanding_sealed", payload: unknown) {
  return { protocol_version: "wco-chatgpt-codex-v1", kind, payload_json: JSON.stringify(payload) };
}

function transportWithAgent(turn: (request: any, call: number) => Promise<any>, customLimits = limits) {
  let calls = 0;
  const requests: any[] = [];
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn(value: any) {
      requests.push(value);
      calls += 1;
      return await turn(value, calls);
    },
  } as any, 60);
  const transport = new ChatGptCodexSemanticChallengeTransport({
    client,
    profile,
    limits: customLimits,
    scratchDirectory: "/tmp/wco-challenge-scratch",
    authorityDirectory: "/tmp/wco-challenge-authority",
    now: () => new Date("2026-08-16T10:00:00.000Z"),
  });
  return { transport, requests, calls: () => calls };
}

test("provider transport keeps the blind challenger phase closed and preserves one provider thread", async () => {
  const fixture = transportWithAgent(async (turn, call) => {
    assert.deepEqual(turn.output_schema.properties.kind.enum, ["repository_command", "semantic_understanding_sealed"]);
    assert.equal(turn.read_only, true);
    assert.equal(turn.network_access, false);
    if (call === 1) {
      assert.equal(turn.thread_id, undefined);
      return { thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage };
    }
    assert.equal(turn.thread_id, "challenge-thread-1");
    assert.match(turn.prompt, /Exact repository result for remote request/);
    return { thread_id: "challenge-thread-1", output: provider("semantic_understanding_sealed", sealed()), usage };
  });

  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-1");
  const replay = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-1");
  assert.deepEqual(replay, identity);
  assert.equal(identity.created_at, "2026-08-16T10:00:00.000Z");

  const first = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  assert.equal(first?.type, "repository_command");
  if (!first || first.type !== "repository_command") throw new Error("expected repository command");
  assert.equal(first.sequence, 1);
  assert.match(first.request_id, /^remote-001-/);
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1), /pending repository result/i);

  const repositoryResult = {
    request_id: first.request_id,
    result: { kind: "summary", repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40), tree_sha: "c".repeat(40) },
  } as any;
  await fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, repositoryResult, "result-1");
  await fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, structuredClone(repositoryResult), "result-1");
  await assert.rejects(
    fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, { ...repositoryResult, result: { kind: "summary", tree_sha: "d".repeat(40) } } as any, "result-1"),
    /idempotency replay conflicts/i,
  );

  const second = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1);
  assert.equal(second?.type, "semantic_understanding_sealed");
  assert.equal(second?.sequence, 2);
  assert.deepEqual(await fixture.transport.receiveSemanticUnderstanding(identity.job_id), sealed());
  assert.equal(await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 2), null);
  assert.equal(fixture.calls(), 2);
});

test("provider transport rejects stale cursors, wrong result identities, and idempotency drift before another turn", async () => {
  const fixture = transportWithAgent(async () => ({ thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage }));
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-2");
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1), /cursor is stale or invalid/i);
  const first = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  if (!first || first.type !== "repository_command") throw new Error("expected repository command");
  await assert.rejects(fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, { request_id: "wrong", result: {} } as any, "wrong"), /request identity mismatched/i);
  const drifted = createSemanticChallengeRequest({ challengeId: request.challenge_id, repository: request.repository, originalGoal: "different goal" });
  await assert.rejects(fixture.transport.createSemanticChallengeJob(drifted, "challenge-provider-2"), /idempotency replay conflicts/i);
  assert.equal(fixture.calls(), 1);
});

test("provider transport rejects provider thread drift", async () => {
  const fixture = transportWithAgent(async (_turn, call) => call === 1
    ? { thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage }
    : { thread_id: "challenge-thread-2", output: provider("semantic_understanding_sealed", sealed()), usage });
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-3");
  const first = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  if (!first || first.type !== "repository_command") throw new Error("expected repository command");
  await fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, { request_id: first.request_id, result: { kind: "summary" } } as any, "result-1");
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1), /thread identity drifted/i);
});

test("provider transport enforces the configured turn budget before another provider side effect", async () => {
  const oneTurn = { ...limits, maximum_total_agent_turns: 1 };
  const fixture = transportWithAgent(async () => ({ thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage }), oneTurn);
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-4");
  const first = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  if (!first || first.type !== "repository_command") throw new Error("expected repository command");
  await fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, { request_id: first.request_id, result: { kind: "summary" } } as any, "result-1");
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1), /budget is exhausted/i);
  assert.equal(fixture.calls(), 1);
});

test("provider transport enforces total wall-clock budget before another provider side effect", async () => {
  let now = Date.parse("2026-08-16T10:00:00.000Z");
  let calls = 0;
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn() {
      calls += 1;
      return { thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage };
    },
  } as any, 60);
  const transport = new ChatGptCodexSemanticChallengeTransport({
    client,
    profile,
    limits: { ...limits, maximum_total_seconds: 1 },
    scratchDirectory: "/tmp/wco-challenge-scratch",
    authorityDirectory: "/tmp/wco-challenge-authority",
    now: () => new Date(now),
  });
  const identity = await transport.createSemanticChallengeJob(request, "challenge-provider-5");
  now += 1_001;
  await assert.rejects(transport.waitForSemanticChallengeAction(identity.job_id, 0), /budget is exhausted/i);
  assert.equal(calls, 0);
});
