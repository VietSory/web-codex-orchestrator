import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateConfig } from "../src/config/config-validator.js";
import { NativeAgentRunGuard } from "../src/web-bridge/native-agent-run-guard.js";
import {
  readNativeOpenAiCredential,
  removeNativeOpenAiCredential,
  writeNativeOpenAiCredential,
  type NativeOpenAiCredential,
} from "../src/web-bridge/native-openai-credential.js";
import { handleNativeMcpRequest, WCO_MCP_PROTOCOL_VERSION, WCO_NATIVE_MCP_TOOLS } from "../src/web-bridge/native-mcp-server.js";
import { triggerWorkspaceAgent } from "../src/web-bridge/workspace-agent-client.js";

const credential: NativeOpenAiCredential = {
  schema_version: "1.0",
  tunnel_id: `tunnel_${"a".repeat(32)}`,
  control_plane_api_key: `sk-${"c".repeat(40)}`,
  workspace_agent_trigger_id: "agtch_example1234567890",
  workspace_agent_access_token: `wsa_${"d".repeat(40)}`,
};

function rpc(value: string | null): any {
  assert.ok(value);
  return JSON.parse(value);
}

function nativeConfig(webBridge: Record<string, unknown> = { mode: "web_native_mcp", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 }): Record<string, unknown> {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 2_000, stable_age_ms: 3_000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: { repo: { path: path.resolve("/tmp/wco-native-repo"), remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    web_bridge: webBridge,
  };
}

test("web_native_mcp is a first-class trusted config profile with no relay/GPT URL authority", () => {
  assert.equal(validateConfig(nativeConfig()).ok, true);
  const withRelay = validateConfig(nativeConfig({ mode: "web_native_mcp", relay_url: "https://relay.example", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 }));
  assert.equal(withRelay.ok, false);
  assert.match(withRelay.issues.map((item) => item.message).join(" "), /web_native_mcp.*relay_url.*forbidden/i);
});

test("Web-native credential is owner-local, round-trips, and rejects drifted tunnel identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-native-credential-"));
  const target = await writeNativeOpenAiCredential(root, credential);
  assert.ok(target.startsWith(root));
  assert.deepEqual(await readNativeOpenAiCredential(root), credential);
  await assert.rejects(
    writeNativeOpenAiCredential(root, { ...credential, tunnel_id: "tunnel_NOT_OFFICIAL" }),
    /tunnel_id is invalid/,
  );
  await assert.rejects(
    writeNativeOpenAiCredential(root, { ...credential, extra: "not-allowed" } as any),
    /schema is invalid/,
  );
  await removeNativeOpenAiCredential(root);
  await assert.rejects(readNativeOpenAiCredential(root), /WEB_NATIVE_SETUP_REQUIRED|not configured/);
});

test("native MCP advertises deterministic modern discovery and narrow semantic tools", async () => {
  const discovered = rpc(await handleNativeMcpRequest({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }));
  assert.equal(discovered.result.resultType, "complete");
  assert.ok(discovered.result.supportedVersions.includes(WCO_MCP_PROTOCOL_VERSION));

  const initialized = rpc(await handleNativeMcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
  assert.equal(initialized.result.protocolVersion, "2025-11-25");

  const first = rpc(await handleNativeMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": WCO_MCP_PROTOCOL_VERSION } } }));
  const second = rpc(await handleNativeMcpRequest({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": WCO_MCP_PROTOCOL_VERSION } } }));
  assert.deepEqual(first.result.tools, second.result.tools);
  assert.deepEqual(first.result.tools.map((tool: any) => tool.name), WCO_NATIVE_MCP_TOOLS.map((tool) => tool.name));
  assert.equal(first.result.cacheScope, "public");
  assert.ok(first.result.ttlMs > 0);

  for (const tool of first.result.tools) {
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
  for (const name of ["wco_submit_contract", "wco_submit_implementation", "wco_submit_review_verdict"]) {
    assert.equal(first.result.tools.find((tool: any) => tool.name === name).annotations.readOnlyHint, false);
  }
  for (const tool of first.result.tools.filter((tool: any) => !tool.name.startsWith("wco_submit_"))) {
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test("Workspace Agent trigger honors official 202-with-no-body contract and stable idempotency headers", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 202 });
  };
  const receipt = await triggerWorkspaceAgent({ credential, input: "continue WCO", conversationKey: "wco-author-1", idempotencyKey: "wco-call-1", fetchImpl: fakeFetch });
  assert.equal(receipt.accepted, true);
  assert.match(receipt.agent_trigger_run_id, /^accepted_[a-f0-9]{48}$/);
  assert.equal(receipt.conversation_url, "https://chatgpt.com/");
  assert.match(receipt.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/workspace_agents\/agtch_example1234567890\/trigger$/);
  const headers = new Headers(requests[0]!.init?.headers);
  assert.equal(headers.get("OpenAI-Beta"), "workspace_agent_runs=v1");
  assert.equal(headers.get("Idempotency-Key"), "wco-call-1");
  assert.match(headers.get("Authorization") ?? "", /^Bearer /);
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), { conversation_key: "wco-author-1", input: "continue WCO" });
});

test("Workspace Agent trigger ignores provider response-body inventions and uses local deterministic receipt", async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    conversation_url: "https://chatgpt.com/c/should-not-be-authority",
    agent_trigger_run_id: "apirun_should_not_be_authority",
  }), { status: 202, headers: { "content-type": "application/json" } });
  const receipt = await triggerWorkspaceAgent({ credential, input: "continue", conversationKey: "wco-author-1", idempotencyKey: "wco-call-body", fetchImpl: fakeFetch });
  assert.match(receipt.agent_trigger_run_id, /^accepted_[a-f0-9]{48}$/);
  assert.notEqual(receipt.agent_trigger_run_id, "apirun_should_not_be_authority");
  assert.equal(receipt.conversation_url, "https://chatgpt.com/");
});

test("Workspace Agent capability denial fails closed without third-party fallback", async () => {
  const fakeFetch: typeof fetch = async () => new Response("forbidden", { status: 403 });
  await assert.rejects(
    triggerWorkspaceAgent({ credential, input: "continue", conversationKey: "wco-author-1", idempotencyKey: "wco-call-2", fetchImpl: fakeFetch }),
    (error: any) => error?.code === "OPENAI_CAPABILITY_BLOCKED" && /will not substitute third-party hosting/.test(error.message),
  );
});

test("native Agent guard performs no provider polling and times out on missing local MCP evidence", async () => {
  let now = 1_000;
  let providerCalls = 0;
  const impossibleProviderFetch: typeof fetch = async () => {
    providerCalls += 1;
    throw new Error("provider status must never be polled");
  };
  const guard = new NativeAgentRunGuard(
    credential,
    `accepted_${"a".repeat(48)}`,
    impossibleProviderFetch,
    () => now,
    2_000,
  );
  assert.equal(await guard.assertCanStillComplete(), "running");
  assert.equal(providerCalls, 0);
  now = 3_001;
  await assert.rejects(
    guard.assertCanStillComplete(),
    (error: any) => error?.code === "WEB_NATIVE_AGENT_TIMEOUT" && /local WCO MCP mailbox/.test(error.message),
  );
  assert.equal(providerCalls, 0);
});
