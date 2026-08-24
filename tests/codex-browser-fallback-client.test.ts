import assert from "node:assert/strict";
import test from "node:test";
import { CodexBrowserFallbackAgentClient, isCodexAllowanceExhausted } from "../src/agent/codex-browser-fallback-client.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../src/agent/contracts.js";

function request(thread_id?: string): AgentTurnRequest {
  return {
    role: "final_reviewer",
    model: "gpt-test",
    reasoning_effort: "high",
    ...(thread_id ? { thread_id } : {}),
    prompt: "test",
    output_schema: { type: "object" },
    read_only: true,
    approval_policy: "never",
    sandbox_mode: "read-only",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/tmp/workspace",
    accepted_bundle_path: "/tmp/bundle",
  };
}

class StubAgent implements AgentClient {
  checks = 0;
  turns: AgentTurnRequest[] = [];
  constructor(private readonly behavior: (value: AgentTurnRequest) => AgentTurnResponse | Promise<AgentTurnResponse>) {}
  async checkAvailability(): Promise<void> { this.checks += 1; }
  async turn(value: AgentTurnRequest): Promise<AgentTurnResponse> { this.turns.push(value); return await this.behavior(value); }
}

function response(thread_id: string): AgentTurnResponse {
  return { thread_id, output: { kind: "ok" }, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
}

test("allowance classifier accepts Codex usage exhaustion but rejects unrelated failures", () => {
  assert.equal(isCodexAllowanceExhausted(Object.assign(new Error("You've hit your usage limit. Try again in 3 hours."), { code: "CODEX_TURN_FAILED" })), true);
  assert.equal(isCodexAllowanceExhausted(Object.assign(new Error("quota exceeded; resets at 20:00 UTC"), { code: "CODEX_TURN_FAILED" })), true);
  assert.equal(isCodexAllowanceExhausted(Object.assign(new Error("Codex authentication is unavailable"), { code: "CODEX_AUTH_UNAVAILABLE" })), false);
  assert.equal(isCodexAllowanceExhausted(Object.assign(new Error("provider timed out"), { code: "CODEX_TURN_TIMEOUT" })), false);
  assert.equal(isCodexAllowanceExhausted(Object.assign(new Error("unexpected internal failure"), { code: "CODEX_TURN_FAILED" })), false);
});

test("first-turn Codex quota exhaustion selects browser and stays sticky for later new threads", async () => {
  const codex = new StubAgent(async () => { throw Object.assign(new Error("You've hit your usage limit. Try again in 2 hours."), { code: "CODEX_TURN_FAILED" }); });
  let browserOrdinal = 0;
  const browser = new StubAgent(async (value) => response(value.thread_id ?? `https://chatgpt.com/c/browser-${++browserOrdinal}`));
  const client = new CodexBrowserFallbackAgentClient(codex, browser);

  const first = await client.turn(request());
  assert.equal(first.thread_id, "https://chatgpt.com/c/browser-1");
  const continuation = await client.turn(request(first.thread_id));
  assert.equal(continuation.thread_id, first.thread_id);
  const independentReview = await client.turn(request());
  assert.equal(independentReview.thread_id, "https://chatgpt.com/c/browser-2");

  assert.equal(codex.turns.length, 1, "only the first failed Codex allowance probe is permitted");
  assert.equal(browser.turns.length, 3);
});

test("non-quota Codex failure never falls back", async () => {
  const codex = new StubAgent(async () => { throw Object.assign(new Error("sandbox failed"), { code: "CODEX_SANDBOX_UNAVAILABLE" }); });
  const browser = new StubAgent(async () => response("https://chatgpt.com/c/should-not-run"));
  const client = new CodexBrowserFallbackAgentClient(codex, browser);
  await assert.rejects(client.turn(request()), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CODEX_SANDBOX_UNAVAILABLE");
  assert.equal(browser.turns.length, 0);
});

test("quota exhaustion mid-Codex-thread fails closed instead of losing hidden thread context", async () => {
  const codex = new StubAgent(async () => { throw Object.assign(new Error("usage limit reached"), { code: "CODEX_TURN_FAILED" }); });
  const browser = new StubAgent(async () => response("https://chatgpt.com/c/should-not-run"));
  const client = new CodexBrowserFallbackAgentClient(codex, browser);
  await assert.rejects(
    client.turn(request("codex-thread-opaque-id")),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "WEB_CHATGPT_BROWSER_MID_THREAD_FALLBACK_UNSAFE",
  );
  assert.equal(browser.turns.length, 0);
});
