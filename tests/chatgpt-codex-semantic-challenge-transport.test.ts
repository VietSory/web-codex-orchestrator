import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentLimits } from "../src/config/contracts.js";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { ChatGptCodexSemanticChallengeTransport } from "../src/web-bridge/chatgpt-codex-semantic-challenge-transport.js";
import { CHATGPT_CODEX_CHALLENGE_PHASE_MARKER, ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

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
const cleanEvents = [
  { type: "thread.started", timestamp: "2026-08-16T10:00:00.000Z" },
  { type: "turn.started", timestamp: "2026-08-16T10:00:00.001Z" },
  { type: "reasoning", timestamp: "2026-08-16T10:00:00.002Z" },
  { type: "agent_message", timestamp: "2026-08-16T10:00:00.003Z" },
  { type: "turn.completed", timestamp: "2026-08-16T10:00:00.004Z" },
];

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

function blindDirectories() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wco-provider-challenge-"));
  const scratchDirectory = path.join(root, "scratch");
  const authorityDirectory = path.join(root, "authority");
  mkdirSync(scratchDirectory, { mode: 0o700 });
  mkdirSync(authorityDirectory, { mode: 0o700 });
  return { root, scratchDirectory, authorityDirectory };
}

function transportWithAgent(
  turn: (request: any, call: number) => Promise<any>,
  customLimits = limits,
  extras: { now?: () => Date; directories?: ReturnType<typeof blindDirectories> } = {},
) {
  let calls = 0;
  const requests: any[] = [];
  const directories = extras.directories ?? blindDirectories();
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn(value: any) {
      requests.push(value);
      calls += 1;
      const response = await turn(value, calls);
      return { ...response, public_events: response.public_events ?? cleanEvents };
    },
  } as any, 60);
  const transport = new ChatGptCodexSemanticChallengeTransport({
    client,
    profile,
    limits: customLimits,
    scratchDirectory: directories.scratchDirectory,
    authorityDirectory: directories.authorityDirectory,
    now: extras.now ?? (() => new Date("2026-08-16T10:00:00.000Z")),
  });
  return { transport, requests, directories, calls: () => calls };
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

test("provider transport rejects provider thread drift and makes the completed provider turn non-replayable", async () => {
  const fixture = transportWithAgent(async (_turn, call) => call === 1
    ? { thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage }
    : { thread_id: "challenge-thread-2", output: provider("semantic_understanding_sealed", sealed()), usage });
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-3");
  const first = await fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  if (!first || first.type !== "repository_command") throw new Error("expected repository command");
  await fixture.transport.submitSemanticChallengeRepositoryResult(identity.job_id, { request_id: first.request_id, result: { kind: "summary" } } as any, "result-1");
  await assert.rejects(
    fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_THREAD_DRIFT",
  );
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 1), /ambiguous and cannot be replayed/i);
  assert.equal(fixture.calls(), 2);
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

test("provider transport enforces its exact public expiry before another provider side effect", async () => {
  let now = Date.parse("2026-08-16T10:00:00.000Z");
  const fixture = transportWithAgent(
    async () => ({ thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage }),
    { ...limits, maximum_total_seconds: 1 },
    { now: () => new Date(now) },
  );
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-5");
  assert.equal(Date.parse(identity.expires_at) - Date.parse(identity.created_at), 1_000);
  now += 1_000;
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0), /budget is exhausted/i);
  assert.equal(fixture.calls(), 0);
});

test("Web-A candidate bytes in either provider filesystem root fail before a blind challenger turn", async () => {
  const directories = blindDirectories();
  const marker = "WEB_A_CANDIDATE_CONTRACT_MUST_NEVER_REACH_WEB_B";
  writeFileSync(path.join(directories.authorityDirectory, "candidate-contract.json"), marker, "utf8");
  const fixture = transportWithAgent(
    async () => { throw new Error("provider must not be called"); },
    limits,
    { directories },
  );
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-blind-fs");
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0), /authority directory must remain empty and challenge-only/i);
  assert.equal(fixture.calls(), 0);
});

test("semantic client itself refuses challenge filesystem candidate bytes even without the transport precheck", async () => {
  const directories = blindDirectories();
  writeFileSync(path.join(directories.scratchDirectory, "web-a-candidate.txt"), "WEB_A_PRIVATE_CANDIDATE", "utf8");
  let calls = 0;
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn() { calls += 1; throw new Error("agent must not run"); },
  } as any, 60);
  await assert.rejects(
    client.turn({
      profile,
      prompt: `${CHATGPT_CODEX_CHALLENGE_PHASE_MARKER}\nblind challenger boundary test`,
      scratchDirectory: directories.scratchDirectory,
      authorityDirectory: directories.authorityDirectory,
    }),
    /CHALLENGE_FILESYSTEM_INVALID.*scratch.*must remain empty/i,
  );
  assert.equal(calls, 0);
});

test("concurrent waits cannot duplicate one provider side effect", async () => {
  const directories = blindDirectories();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const fixture = transportWithAgent(async () => {
    entered();
    await blocked;
    return { thread_id: "challenge-thread-1", output: provider("repository_command", { operation: "summary" }), usage };
  }, limits, { directories });
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-concurrent");
  const first = fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0);
  await providerEntered;
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0), /already in flight/i);
  assert.equal(fixture.calls(), 1);
  release();
  const action = await first;
  assert.equal(action?.sequence, 1);
  assert.equal(fixture.calls(), 1);
});

test("provider failure becomes terminal ambiguity instead of a blind retry", async () => {
  const fixture = transportWithAgent(async () => { throw new Error("provider transport dropped after request"); });
  const identity = await fixture.transport.createSemanticChallengeJob(request, "challenge-provider-ambiguous");
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0), /provider transport dropped/i);
  await assert.rejects(fixture.transport.waitForSemanticChallengeAction(identity.job_id, 0), /ambiguous and cannot be replayed/i);
  assert.equal(fixture.calls(), 1);
});
