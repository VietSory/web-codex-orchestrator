import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexSdkAgentClient, type CodexFactory } from "../src/agent/codex-sdk-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { ASSESSMENT_OUTPUT_SCHEMA } from "../src/agent/output-schemas.js";
import { ExecutionError } from "../src/execution/errors.js";
import { fakeResolvedCodexRuntime } from "./helpers/codex-runtime-fixture.js";

function request(): AgentTurnRequest {
  return {
    role: "implementer",
    model: "trusted-model",
    reasoning_effort: "high",
    prompt: "return structured output",
    output_schema: ASSESSMENT_OUTPUT_SCHEMA,
    read_only: false,
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/tmp/wco-worktree",
    accepted_bundle_path: "/tmp/wco-bundle",
  };
}

function factoryFor(finalResponse: string): CodexFactory {
  return (() => ({
    startThread(_options: ThreadOptions) {
      return {
        id: "bounded-output-thread",
        async runStreamed() {
          async function* events(): AsyncGenerator<ThreadEvent> {
            yield { type: "turn.started" } as ThreadEvent;
            yield {
              type: "item.completed",
              item: { id: "msg", type: "agent_message", text: finalResponse },
            } as ThreadEvent;
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            } as ThreadEvent;
          }
          return { events: events() };
        },
      } as never;
    },
    resumeThread() { throw new Error("unexpected resume"); },
  })) as CodexFactory;
}

test("CODEX-SDK-BOUND-001 rejects an oversized final structured response before JSON parsing", async () => {
  const oversized = JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) });
  const client = new CodexSdkAgentClient(fakeResolvedCodexRuntime(), factoryFor(oversized));
  await assert.rejects(
    () => client.turn(request()),
    (error: unknown) => error instanceof ExecutionError && error.code === "AGENT_OUTPUT_INVALID" && /exceeds/.test(error.message),
  );
});
