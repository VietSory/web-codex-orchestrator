import { strict as assert } from "node:assert";
import test from "node:test";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexSdkAgentClient, type CodexFactory } from "../src/agent/codex-sdk-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { ASSESSMENT_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "../src/agent/output-schemas.js";
import { ExecutionError } from "../src/execution/errors.js";

interface FakeThread {
  id: string | null;
  options?: ThreadOptions;
  runStreamed(input: string, options: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface FakeSdkHarness {
  codexOptions: unknown;
  startOptions: ThreadOptions | undefined;
  resumeId: string | undefined;
  resumeOptions: ThreadOptions | undefined;
  runInput: string | undefined;
  runOptions: { outputSchema?: unknown; signal?: AbortSignal } | undefined;
  thread: FakeThread;
}

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    role: "implementer",
    model: "trusted-model",
    reasoning_effort: "high",
    prompt: "return the structured response",
    output_schema: ASSESSMENT_OUTPUT_SCHEMA,
    read_only: false,
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/tmp/wco-worktree",
    accepted_bundle_path: "/tmp/wco-bundle",
    ...overrides,
  };
}

function harness(finalResponse: string, initialId: string | null = null): { harness: FakeSdkHarness; factory: CodexFactory } {
  const state: FakeSdkHarness = {
    codexOptions: undefined,
    startOptions: undefined,
    resumeId: undefined,
    resumeOptions: undefined,
    runInput: undefined,
    runOptions: undefined,
    thread: {
      id: initialId,
      async runStreamed(input, options) {
        state.runInput = input;
        state.runOptions = options;
        async function* events(): AsyncGenerator<ThreadEvent> {
          if (state.thread.id === null) {
            yield { type: "thread.started", thread_id: "real-thread-id" } as ThreadEvent;
            state.thread.id = "real-thread-id";
          }
          yield { type: "turn.started" } as ThreadEvent;
          yield { type: "item.completed", item: { id: "msg", type: "agent_message", text: finalResponse } } as ThreadEvent;
          yield { type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } } as ThreadEvent;
        }
        return { events: events() };
      },
    },
  };
  const factory = ((options) => {
    state.codexOptions = options;
    return {
      startThread(threadOptions: ThreadOptions) { state.startOptions = threadOptions; return state.thread as never; },
      resumeThread(id: string, threadOptions: ThreadOptions) { state.resumeId = id; state.resumeOptions = threadOptions; return state.thread as never; },
    };
  }) as CodexFactory;
  return { harness: state, factory };
}

test("new SDK thread returns the ID populated after the first turn", async () => {
  const { harness: state, factory } = harness(JSON.stringify({ ok: true }));
  assert.equal(state.thread.id, null);
  const response = await new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, factory).turn(request());
  assert.equal(state.startOptions?.model, "trusted-model");
  assert.equal(state.resumeId, undefined);
  assert.equal(response.thread_id, "real-thread-id");
  assert.equal(state.thread.id, "real-thread-id");
  assert.deepEqual(response.usage, { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7 });
  assert.ok(response.public_events?.some((event) => event.type === "thread.started"));
});

test("resume reconstructs the exact SDK thread and never starts one", async () => {
  const { harness: state, factory } = harness(JSON.stringify({ ok: true }), "existing-thread");
  const response = await new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, factory).turn(request({ thread_id: "existing-thread" }));
  assert.equal(state.resumeId, "existing-thread");
  assert.equal(state.startOptions, undefined);
  assert.equal(response.thread_id, "existing-thread");
});

test("implementer restrictions and exact SDK thread options are enforced", async () => {
  const { harness: state, factory } = harness(JSON.stringify({ ok: true }));
  await new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, factory).turn(request());
  assert.deepEqual(state.startOptions, {
    model: "trusted-model",
    modelReasoningEffort: "high",
    workingDirectory: "/tmp/wco-worktree",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    additionalDirectories: [],
  });
  assert.deepEqual(state.codexOptions, {
    codexPathOverride: "/trusted/codex",
    env: {},
    config: { show_raw_agent_reasoning: false },
  });
});

test("reviewer restrictions, schema, and cancellation signal are passed to the SDK", async () => {
  const { harness: state, factory } = harness(JSON.stringify({ ok: true }));
  const signal = new AbortController().signal;
  await new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, factory).turn(request({ role: "internal_reviewer", output_schema: REVIEW_OUTPUT_SCHEMA, read_only: true, sandbox_mode: "read-only", signal }));
  assert.equal(state.startOptions?.sandboxMode, "read-only");
  assert.equal(state.startOptions?.approvalPolicy, "never");
  assert.equal(state.startOptions?.networkAccessEnabled, false);
  assert.equal(state.startOptions?.webSearchMode, "disabled");
  assert.deepEqual(state.startOptions?.additionalDirectories, []);
  assert.equal(state.runOptions?.outputSchema, REVIEW_OUTPUT_SCHEMA);
  assert.equal(state.runOptions?.signal, signal);
});

test("invalid JSON and missing thread ID return stable errors", async () => {
  const invalid = harness("not-json");
  await assert.rejects(() => new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, invalid.factory).turn(request()), (error: unknown) => error instanceof ExecutionError && error.code === "AGENT_OUTPUT_INVALID");
  const missing = harness(JSON.stringify({ ok: true }));
  missing.harness.thread.id = null;
  missing.harness.thread.runStreamed = async () => {
    async function* withoutThreadId(): AsyncGenerator<ThreadEvent> {
      yield { type: "turn.started" } as ThreadEvent;
      yield { type: "item.completed", item: { id: "msg", type: "agent_message", text: JSON.stringify({ ok: true }) } } as ThreadEvent;
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as ThreadEvent;
    }
    return { events: withoutThreadId() };
  };
  await assert.rejects(() => new CodexSdkAgentClient({ executable: "/trusted/codex", environment: {} }, missing.factory).turn(request()), (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_TURN_FAILED");
});

test("SDK environment does not inherit provider or credential variables", async () => {
  const previous = { AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.AWS_SECRET_ACCESS_KEY = "fake-aws";
  process.env.GITHUB_TOKEN = "fake-github";
  process.env.OPENAI_API_KEY = "fake-openai";
  process.env.SSH_AUTH_SOCK = "fake-ssh";
  try {
    const { harness: state, factory } = harness(JSON.stringify({ ok: true }));
    await new CodexSdkAgentClient({ executable: "/trusted/codex", environment: { PATH: "/trusted/bin", AWS_SECRET_ACCESS_KEY: "runtime-aws", GITHUB_TOKEN: "runtime-github", OPENAI_API_KEY: "runtime-openai", SSH_AUTH_SOCK: "runtime-ssh" } }, factory).turn(request());
    const options = state.codexOptions as { env: Record<string, string> };
    assert.deepEqual(options.env, { PATH: "/trusted/bin" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
