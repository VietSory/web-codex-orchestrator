import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { loadTrustedConfig } from "../src/config/config-loader.js";
import { writeRelayToken, readRelayToken, removeRelayToken } from "../src/web-bridge/relay-credential.js";
import { configureWebBridgeConnection, disconnectWebBridgeConnection } from "../src/web-bridge/connection-setup.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { PersonalBearerAuthenticator } from "../src/web-bridge/relay/auth.js";
import { createRelayServer } from "../src/web-bridge/relay/server.js";
import { planSelfUninstall } from "../src/uninstall/self-uninstall.js";
import { listLocalTaskHistory } from "../src/web-bridge/session-history.js";
import { runWebCommand } from "../src/web-bridge/web-cli.js";
import { initialWorkflowContinueArguments } from "../src/tui/interactive-app.js";

function minimalConfig(repoPath: string): any {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 2_000, stable_age_ms: 3_000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: { repo: { path: repoPath, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    web_bridge: { mode: "manual_file", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 },
  };
}

test("relay credential persists only under WCO credentials and can be removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-credential-"));
  const credentials = path.join(root, "credentials");
  const token = "r".repeat(40);
  const target = await writeRelayToken(credentials, token);
  assert.equal(await readRelayToken(credentials, {}), token);
  assert.ok(target.startsWith(credentials));
  await removeRelayToken(credentials);
  await assert.rejects(readRelayToken(credentials, {}), /not configured|AUTH_UNAVAILABLE/i);
});

test("one-time Web connect verifies relay before persisting actions_relay config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-connect-"));
  const repo = path.join(root, "repo"), configPath = path.join(root, "home", "config.json"), credentials = path.join(root, "home", "credentials"), relayRoot = path.join(root, "relay");
  await mkdir(repo, { recursive: true });
  await writeTrustedConfigAtomic(configPath, minimalConfig(repo));
  const token = "t".repeat(40);
  const server = createRelayServer({ store: new RelayFileStore(relayRoot), authenticator: new PersonalBearerAuthenticator([{ owner: "user", token }]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const connected = await configureWebBridgeConnection({ configPath, credentialsDirectory: credentials, relayUrl: `http://127.0.0.1:${address.port}`, gptUrl: "https://chatgpt.com/g/example-wco", token });
    assert.equal(connected.status.connected, true);
    const saved = await loadTrustedConfig(configPath);
    assert.equal(saved.web_bridge?.mode, "actions_relay");
    assert.equal(saved.web_bridge?.gpt_url, "https://chatgpt.com/g/example-wco");
    assert.equal(await readRelayToken(credentials, {}), token);
    const disconnected = await disconnectWebBridgeConnection({ configPath, credentialsDirectory: credentials });
    assert.equal(disconnected.web_bridge?.mode, "manual_file");
    await assert.rejects(readRelayToken(credentials, {}), /not configured|AUTH_UNAVAILABLE/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("disconnected manual bridge status never claims the relay is connected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-web-status-"));
  const old = process.env.WCO_HOME;
  process.env.WCO_HOME = root;
  try {
    await writeTrustedConfigAtomic(path.join(root, "config.json"), minimalConfig(path.join(root, "repo")));
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runWebCommand(["status"], { write: (value) => stdout.push(value), error: (value) => stderr.push(value) });
    assert.equal(code, 1);
    assert.match(stdout.join(""), /Relay\s+disconnected/);
    assert.doesNotMatch(stdout.join(""), /Relay\s+connected/);
    assert.equal(stderr.join(""), "");
  } finally {
    if (old === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = old;
  }
});

test("Web CLI preserves stable structured error codes for unsafe relay input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-web-error-code-"));
  const old = process.env.WCO_HOME;
  process.env.WCO_HOME = root;
  try {
    await writeTrustedConfigAtomic(path.join(root, "config.json"), minimalConfig(path.join(root, "repo")));
    const answers = ["http://example.com/relay", "https://chatgpt.com/g/test", "x".repeat(40)];
    const stderr: string[] = [];
    const code = await runWebCommand(["connect"], { write: () => undefined, error: (value) => stderr.push(value), question: async () => answers.shift()! });
    assert.equal(code, 1);
    assert.match(stderr.join(""), /^WEB_RELAY_URL_UNSAFE:/);
    assert.doesNotMatch(stderr.join(""), /x{16,}/);
    await assert.rejects(readRelayToken(path.join(root, "credentials"), {}), /not configured|AUTH_UNAVAILABLE/i);
  } finally {
    if (old === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = old;
  }
});

test("history reader returns bounded repository-specific sessions newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-history-"));
  const history = path.join(root, "bridge", "sessions", "history");
  await mkdir(history, { recursive: true });
  const base = { schema_version: "1.0", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, job_id: null, last_event_sequence: 0, sealed: false, contract: null, task_archive_path: null, run_id: null, web_pack_path: null, state: "BLOCKED", created_at: "2026-01-01T00:00:00.000Z" };
  await Promise.all([
    import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(history, "one.json"), JSON.stringify({ ...base, session_id: "one", goal: "older", updated_at: "2026-01-01T00:00:01.000Z" }))),
    import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(history, "two.json"), JSON.stringify({ ...base, session_id: "two", goal: "newer", updated_at: "2026-01-01T00:00:02.000Z" }))),
    import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(history, "other.json"), JSON.stringify({ ...base, session_id: "other", repository: { ...base.repository, repository_id: "other" }, goal: "ignore", updated_at: "2026-01-01T00:00:03.000Z" }))),
  ]);
  assert.deepEqual((await listLocalTaskHistory(root, "repo", 10)).map((item) => item.goal), ["newer", "older"]);
});

test("global install plan schedules npm self-removal while source checkout remains protected", () => {
  const globalPlan = planSelfUninstall("/usr/local/lib/node_modules/web-codex-orchestrator/dist/uninstall/self-uninstall.js");
  assert.equal(globalPlan.supported, true);
  assert.deepEqual(globalPlan.command, ["npm", "uninstall", "--global", "--prefix", "/usr/local", "web-codex-orchestrator"]);
  const isolatedGlobalPlan = planSelfUninstall("/tmp/wco-prefix/lib/node_modules/web-codex-orchestrator/dist/uninstall/self-uninstall.js");
  assert.deepEqual(isolatedGlobalPlan.command, ["npm", "uninstall", "--global", "--prefix", "/tmp/wco-prefix", "web-codex-orchestrator"]);
  const localPlan = planSelfUninstall("/tmp/wco-prefix/node_modules/web-codex-orchestrator/dist/uninstall/self-uninstall.js");
  assert.deepEqual(localPlan.command, ["npm", "uninstall", "--prefix", "/tmp/wco-prefix", "web-codex-orchestrator"]);
  const sourcePlan = planSelfUninstall("/work/web-codex-orchestrator/dist/uninstall/self-uninstall.js");
  assert.equal(sourcePlan.supported, false);
  assert.match(sourcePlan.explanation, /source checkout|npm link/i);
});

test("Senior Architect instructions ship positive and negative behavioral examples", async () => {
  const source = await readFile(new URL("../web/gpt/WCO-SENIOR-ARCHITECT.md", import.meta.url), "utf8");
  assert.match(source, /Positive authoring example/);
  assert.match(source, /Negative prompt-injection example/);
  assert.match(source, /untrusted data/);
});

test("TUI hands the exact durable Web pack to the first orchestration continue", () => {
  const runId = `TASK-EXAMPLE:${"a".repeat(64)}`;
  const webPack = "/tmp/wco/state/bridge/artifacts/job/web-implementation-pack.zip";
  assert.deepEqual(initialWorkflowContinueArguments({ run_id: runId, state: "IMPLEMENTATION_REGISTERED", web_pack_path: webPack }, "/tmp/wco/state", "/tmp/wco/config.json"), [
    "--run-id", runId,
    "--state-dir", "/tmp/wco/state",
    "--config", "/tmp/wco/config.json",
    "--web-pack", webPack,
    "--max-transitions", "8",
  ]);
  assert.throws(() => initialWorkflowContinueArguments({ run_id: runId, state: "IMPLEMENTATION_REGISTERED", web_pack_path: null }, "/tmp/wco/state", "/tmp/wco/config.json"), /WEB_PACK_NOT_REGISTERED/);
});
