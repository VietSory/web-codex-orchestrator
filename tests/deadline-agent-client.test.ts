import test from "node:test";
import assert from "node:assert/strict";
import { DeadlineAgentClient } from "../src/agent/deadline-agent-client.js";
import type { AgentClient, AgentTurnRequest } from "../src/agent/contracts.js";
import { ExecutionError } from "../src/execution/errors.js";

function request(signal?: AbortSignal): AgentTurnRequest {
  return {
    role: "implementer",
    model: "test-model",
    reasoning_effort: "low",
    prompt: "test",
    output_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    read_only: false,
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/tmp/wco-deadline-worktree",
    accepted_bundle_path: "/tmp/wco-deadline-bundle",
    ...(signal ? { signal } : {}),
  };
}

test("AGENT-DEADLINE-001 aborts a never-ending production turn at the configured deadline", async () => {
  let observedAbort = false;
  const inner: AgentClient = {
    async checkAvailability() {},
    async turn(turnRequest) {
      await new Promise<void>((resolve) => {
        turnRequest.signal?.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      return { thread_id: "late", output: {} };
    },
  };
  const client = new DeadlineAgentClient(inner, 1);
  await assert.rejects(
    () => client.turn(request()),
    (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_TURN_TIMEOUT",
  );
  assert.equal(observedAbort, true);
});

test("AGENT-DEADLINE-002 relays caller cancellation without waiting for the deadline", async () => {
  const controller = new AbortController();
  const inner: AgentClient = {
    async checkAvailability() {},
    async turn(turnRequest) {
      await new Promise<void>((resolve) => turnRequest.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new ExecutionError("INTERRUPTED", "cancelled");
    },
  };
  const client = new DeadlineAgentClient(inner, 10);
  const turn = client.turn(request(controller.signal));
  controller.abort();
  await assert.rejects(
    () => turn,
    (error: unknown) => error instanceof ExecutionError && error.code === "INTERRUPTED",
  );
});
