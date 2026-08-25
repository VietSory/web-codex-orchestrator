import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ChatGptWebCompanionAgentClient,
  isChatGptWebCompanionConfigured,
} from "../src/agent/chatgpt-web-companion-client.js";
import {
  PINNED_MIUUYY_CHATGPT_WEB_SHA,
  WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
  WCO_CHATGPT_WEB_COMPANION_TRANSPORT,
} from "../src/agent/chatgpt-web-companion-protocol.js";
import { ChatGptBrowserWebBridge } from "../src/web-bridge/chatgpt-browser-bridge.js";

function minimalConfig(repoPath: string): any {
  return {
    config_version: "1.0",
    inbox: {
      poll_interval_ms: 2_000,
      stable_age_ms: 3_000,
      stable_observations: 2,
      maximum_candidates_per_scan: 100,
    },
    repositories: {
      repo: {
        path: repoPath,
        remote: "origin",
        expected_remote_urls: ["https://github.com/example/repo.git"],
        fetch_policy: "never",
      },
    },
    runtime: { source: "bundled" },
  };
}

async function fakeCompanionScript(root: string): Promise<string> {
  const script = path.join(root, "fake-companion.mjs");
  await writeFile(script, `
let source = "";
for await (const chunk of process.stdin) source += chunk.toString();
const request = JSON.parse(source.trim());
const pin = process.env.FAKE_BAD_PIN === "1"
  ? "0000000000000000000000000000000000000000"
  : ${JSON.stringify(PINNED_MIUUYY_CHATGPT_WEB_SHA)};
const base = {
  protocol: ${JSON.stringify(WCO_CHATGPT_WEB_COMPANION_PROTOCOL)},
  id: request.id,
  ok: true,
  provider: "chatgpt-web",
  transport: ${JSON.stringify(WCO_CHATGPT_WEB_COMPANION_TRANSPORT)},
  upstream_sha: pin,
  temporary_chat: true,
  sol_available: true,
  pro_available: false
};
if (request.type === "probe") {
  process.stdout.write(JSON.stringify(base));
  process.exit(0);
}
let output = { ok: true };
if (request.prompt.includes("CONTEXT_SENTINEL")) output = { saw_context: true };
else if (request.prompt.includes("SECOND_TURN")) {
  output = { saw_replay: request.prompt.includes("FIRST_OUTPUT_MARKER") };
} else if (request.prompt.includes("FIRST_TURN")) {
  output = { marker: "FIRST_OUTPUT_MARKER" };
}
process.stdout.write(JSON.stringify({
  ...base,
  mode: request.mode,
  model_id: "gpt-5.6-sol",
  answer: JSON.stringify(output)
}));
`, { encoding: "utf8", mode: 0o600 });
  return script;
}

function companionEnv(root: string, script: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WCO_CHATGPT_WEB_COMPANION_EXE: process.execPath,
    WCO_CHATGPT_WEB_COMPANION_ARGS_JSON: JSON.stringify([script]),
    WCO_CHATGPT_WEB_MIUUYY_ROOT: path.join(root, "upstream"),
    WCO_CHATGPT_WEB_COMPANION_MODE: "high",
    WCO_CHATGPT_WEB_COMPANION_TIMEOUT_SECONDS: "5",
  };
}

type CompanionTurnRequest = Parameters<ChatGptWebCompanionAgentClient["turn"]>[0];

function turnRequest(overrides: Partial<CompanionTurnRequest> = {}): CompanionTurnRequest {
  return {
    role: "final_reviewer",
    model: "ignored-by-chatgpt-web-companion",
    reasoning_effort: "xhigh",
    prompt: "Return JSON.",
    output_schema: { type: "object" },
    read_only: true,
    approval_policy: "never",
    sandbox_mode: "read-only",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/unused/workspace",
    accepted_bundle_path: "/unused/bundle",
    ...overrides,
  };
}

test("ChatGPT Web companion performs probe and provider turn over bounded stdio", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const env = companionEnv(root, script);

  assert.equal(isChatGptWebCompanionConfigured(env), true);
  const client = new ChatGptWebCompanionAgentClient({ env });
  await client.checkAvailability();

  const result = await client.turn(turnRequest());
  assert.match(result.thread_id, /^wco-chatgpt-web:/);
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
  });
  assert.deepEqual(result.public_events?.map((event) => event.type), [
    "thread.started",
    "turn.started",
    "agent_message",
    "turn.completed",
  ]);
});

test("implementation companion prompt carries WCO's bounded accepted repository context inline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const workspace = path.join(root, "workspace");
  const bundle = path.join(root, "bundle");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(workspace, "src", "sample.txt"), "CONTEXT_SENTINEL\n", "utf8");
  await writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify({ allowed_paths: ["src/**"], forbidden_paths: [] }),
    "utf8",
  );

  const client = new ChatGptWebCompanionAgentClient({
    env: companionEnv(root, script),
  });
  const result = await client.turn(turnRequest({
    role: "implementer",
    prompt: "Inspect only the supplied WCO context.",
    workspace_path: workspace,
    accepted_bundle_path: bundle,
  }));
  assert.deepEqual(result.output, { saw_context: true });
});

test("continuation uses a stable logical thread and replays prior JSON into a fresh Temporary Chat turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-thread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const client = new ChatGptWebCompanionAgentClient({
    env: companionEnv(root, script),
  });

  const first = await client.turn(turnRequest({ prompt: "FIRST_TURN" }));
  assert.deepEqual(first.output, { marker: "FIRST_OUTPUT_MARKER" });

  const second = await client.turn(turnRequest({
    prompt: "SECOND_TURN",
    thread_id: first.thread_id,
  }));
  assert.equal(second.thread_id, first.thread_id);
  assert.deepEqual(second.output, { saw_replay: true });
  assert.deepEqual(second.public_events?.map((event) => event.type), [
    "turn.started",
    "agent_message",
    "turn.completed",
  ]);
});

test("companion refuses unknown logical continuation rather than fabricating history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const client = new ChatGptWebCompanionAgentClient({
    env: companionEnv(root, script),
  });

  await assert.rejects(
    () => client.turn(turnRequest({
      prompt: "SECOND_TURN",
      thread_id: "wco-chatgpt-web:missing",
    })),
    (error: unknown) => (
      Boolean(error)
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_THREAD_UNKNOWN"
    ),
  );
});

test("companion pin attestation fails closed on an unreviewed miuuyy checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const client = new ChatGptWebCompanionAgentClient({
    env: {
      ...companionEnv(root, script),
      FAKE_BAD_PIN: "1",
    },
  });

  await assert.rejects(
    () => client.checkAvailability(),
    (error: unknown) => (
      Boolean(error)
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_ATTESTATION_INVALID"
    ),
  );
});

test("browser PAIR selects configured companion without touching Codex runtime/auth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-companion-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await fakeCompanionScript(root);
  const env = {
    ...companionEnv(root, script),
    CI: "",
    WCO_CODEX_EXECUTABLE: path.join(root, "must-not-run-codex"),
  };

  const bridge = new ChatGptBrowserWebBridge(
    minimalConfig(root),
    path.join(root, "bridge"),
    path.join(root, "state"),
    env,
  );
  const status = await bridge.getConnectionStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.account, "ChatGPT Web companion");
});
