import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ChatGptWebCompanionAgentClient,
  chatGptWebCompanionChildEnvironment,
  isChatGptWebCompanionConfigured,
} from "../src/agent/chatgpt-web-companion-client.js";
import {
  MIUUYY_LAUNCHER_DESCRIPTOR_KIND,
  MIUUYY_LAUNCHER_DESCRIPTOR_VERSION,
  PINNED_MIUUYY_CHATGPT_WEB_RELEASE,
} from "../src/agent/chatgpt-web-companion-protocol.js";
import { ChatGptBrowserReviewerAgentClient } from "../src/agent/chatgpt-browser-reviewer-client.js";
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

async function fakeHelperScript(root: string): Promise<string> {
  const script = path.join(root, "fake-miuuyy-helper.mjs");
  await writeFile(script, `
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    input.close();
    setImmediate(() => process.exit(0));
    return;
  }
  if (request.type === "abort") return;
  if (request.type === "inspect") {
    send({
      type: "result",
      id: request.id,
      value: {
        authenticated: true,
        temporary: true,
        url: "https://chatgpt.com/?temporary-chat=true",
        solAvailable: process.env.FAKE_CAPABILITY_MISMATCH === "1" ? false : true,
        proAvailable: false
      }
    });
    return;
  }
  if (request.type !== "run") {
    send({ type: "error", id: request.id, message: "unsupported request" });
    return;
  }
  let output = { ok: true };
  const prompt = request.turn?.prepared?.text ?? "";
  if (prompt.includes("CONTEXT_SENTINEL")) output = { saw_context: true };
  else if (prompt.includes("SECOND_TURN")) {
    output = { saw_replay: prompt.includes("FIRST_OUTPUT_MARKER") };
  } else if (prompt.includes("FIRST_TURN")) {
    output = { marker: "FIRST_OUTPUT_MARKER" };
  }
  send({ type: "result", id: request.id, text: JSON.stringify(output) });
});
`, { encoding: "utf8", mode: 0o600 });
  return script;
}

async function fakeMiuuyyInstall(
  root: string,
  options: { releaseVersion?: string; solAvailable?: boolean; proAvailable?: boolean; bom?: boolean } = {},
): Promise<{ configPath: string; helperScript: string }> {
  const helperScript = await fakeHelperScript(root);
  const descriptorPath = path.join(root, "browser-host.json");
  await writeFile(descriptorPath, JSON.stringify({
    version: MIUUYY_LAUNCHER_DESCRIPTOR_VERSION,
    kind: MIUUYY_LAUNCHER_DESCRIPTOR_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:43101",
    control: {
      endpoint: "http://127.0.0.1:43102",
      token: "a".repeat(48),
    },
    helper: {
      executable: process.execPath,
      script: helperScript,
    },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "s".repeat(32),
    createdAt: new Date().toISOString(),
  }), "utf8");

  const configPath = path.join(root, "config.json");
  const config = JSON.stringify({
    version: 3,
    releaseVersion: options.releaseVersion ?? PINNED_MIUUYY_CHATGPT_WEB_RELEASE,
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    appName: "Codex Native2",
    solAvailable: options.solAvailable ?? true,
    proAvailable: options.proAvailable ?? false,
  });
  await writeFile(configPath, `${options.bom ? "\uFEFF" : ""}${config}`, "utf8");
  return { configPath, helperScript };
}

function companionEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WCO_CHATGPT_WEB_MIUUYY_CONFIG: configPath,
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

test("ChatGPT Web companion drives the installed miuuyy launcher helper over bounded stdio", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const env = companionEnv(configPath);

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

test("installed miuuyy config accepts a preserved UTF-8 BOM", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-bom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root, { bom: true });
  const client = new ChatGptWebCompanionAgentClient({ env: companionEnv(configPath) });
  await client.checkAvailability();
});

test("implementation helper prompt carries WCO's bounded accepted repository context inline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
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

  const client = new ChatGptWebCompanionAgentClient({ env: companionEnv(configPath) });
  const result = await client.turn(turnRequest({
    role: "implementer",
    prompt: "Inspect only the supplied WCO context.",
    workspace_path: workspace,
    accepted_bundle_path: bundle,
  }));
  assert.deepEqual(result.output, { saw_context: true });
});

test("continuation keeps WCO logical identity while replaying prior JSON into a fresh Web turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-thread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const client = new ChatGptWebCompanionAgentClient({ env: companionEnv(configPath) });

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

test("companion refuses unknown logical continuation rather than inventing history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const client = new ChatGptWebCompanionAgentClient({ env: companionEnv(configPath) });

  await assert.rejects(
    () => client.turn(turnRequest({ prompt: "SECOND_TURN", thread_id: "wco-chatgpt-web:missing" })),
    (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_THREAD_UNKNOWN"
    ),
  );
});

test("companion pins the qualified miuuyy installed release instead of trusting any helper", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root, { releaseVersion: "3.0.2" });

  assert.throws(
    () => new ChatGptWebCompanionAgentClient({ env: companionEnv(configPath) }),
    (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_RELEASE_MISMATCH"
    ),
  );
});

test("companion rejects stale account capability state before a PAIR turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const client = new ChatGptWebCompanionAgentClient({
    env: { ...companionEnv(configPath), FAKE_CAPABILITY_MISMATCH: "1" },
  });
  await assert.rejects(
    () => client.checkAvailability(),
    (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_CAPABILITY_MISMATCH"
    ),
  );
});

test("WSL child environment explicitly forwards Electron helper mode into Win32", () => {
  const env = chatGptWebCompanionChildEnvironment({
    WSLENV: "FOO/p:ELECTRON_RUN_AS_NODE/u",
    FOO: "/tmp/value",
  }, true);
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS, "1");
  const entries = new Set((env.WSLENV ?? "").split(":"));
  assert.equal(entries.has("FOO/p"), true);
  assert.equal(entries.has("ELECTRON_RUN_AS_NODE/w"), true);
  assert.equal(entries.has("CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS/w"), true);
  assert.equal(entries.has("ELECTRON_RUN_AS_NODE/u"), false);
});

test("browser PAIR prefers installed miuuyy helper without touching Codex runtime/auth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const env = {
    ...companionEnv(configPath),
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

test("independent browser reviewer also uses the installed miuuyy helper transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-reviewer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await fakeMiuuyyInstall(root);
  const workspace = path.join(root, "workspace");
  const bundle = path.join(root, "bundle");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(workspace, "src", "review.txt"), "CONTEXT_SENTINEL\n", "utf8");
  await writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify({ allowed_paths: ["src/**"], forbidden_paths: [] }),
    "utf8",
  );

  const reviewer = new ChatGptBrowserReviewerAgentClient({
    stateDirectory: path.join(root, "state"),
    env: companionEnv(configPath),
  });
  await reviewer.checkAvailability();
  const result = await reviewer.turn(turnRequest({
    role: "internal_reviewer",
    prompt: "Review the exact bounded context.",
    workspace_path: workspace,
    accepted_bundle_path: bundle,
  }));
  assert.deepEqual(result.output, { saw_context: true });
});
