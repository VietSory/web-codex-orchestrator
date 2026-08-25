import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptWebCompanionAgentClient } from "../src/agent/chatgpt-web-companion-client.js";
import {
  MIUUYY_LAUNCHER_DESCRIPTOR_KIND,
  MIUUYY_LAUNCHER_DESCRIPTOR_VERSION,
  PINNED_MIUUYY_CHATGPT_WEB_RELEASE,
} from "../src/agent/chatgpt-web-companion-protocol.js";

async function fixture(root: string): Promise<{ configPath: string; markerPath: string }> {
  const markerPath = path.join(root, "sigterm.marker");
  const helperScript = path.join(root, "stubborn-helper.mjs");
  await writeFile(helperScript, `
import fs from "node:fs";
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const keepAlive = setInterval(() => {}, 1000);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.once("SIGTERM", () => {
  fs.writeFileSync(process.env.FAKE_SIGTERM_MARKER, "SIGTERM\\n");
  clearInterval(keepAlive);
  process.exit(0);
});
send({ type: "ready" });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "run") {
    send({ type: "result", id: request.id, text: JSON.stringify({ ok: true }) });
    return;
  }
  // Intentionally ignore shutdown. WCO must wait for the graceful window and
  // then use SIGTERM before it ever resorts to SIGKILL.
});
`, { encoding: "utf8", mode: 0o600 });

  const descriptorPath = path.join(root, "browser-host.json");
  await writeFile(descriptorPath, JSON.stringify({
    version: MIUUYY_LAUNCHER_DESCRIPTOR_VERSION,
    kind: MIUUYY_LAUNCHER_DESCRIPTOR_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:44101",
    control: {
      endpoint: "http://127.0.0.1:44102",
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
  await writeFile(configPath, JSON.stringify({
    version: 3,
    releaseVersion: PINNED_MIUUYY_CHATGPT_WEB_RELEASE,
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    appName: "Codex Native2",
    solAvailable: true,
    proAvailable: false,
  }), "utf8");
  return { configPath, markerPath };
}

async function waitForFile(filePath: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(filePath); return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("companion gives a stubborn helper SIGTERM before forced kill", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath, markerPath } = await fixture(root);
  const client = new ChatGptWebCompanionAgentClient({
    env: {
      ...process.env,
      WCO_CHATGPT_WEB_MIUUYY_CONFIG: configPath,
      WCO_CHATGPT_WEB_COMPANION_MODE: "high",
      WCO_CHATGPT_WEB_COMPANION_TIMEOUT_SECONDS: "8",
      FAKE_SIGTERM_MARKER: markerPath,
    },
  });

  const started = Date.now();
  const result = await client.turn({
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
  });
  assert.deepEqual(result.output, { ok: true });
  assert.ok(Date.now() - started >= 1_500, "stubborn helper should receive the graceful shutdown window");
  assert.ok(Date.now() - started < 7_000, "staged shutdown must remain bounded");
  await waitForFile(markerPath);
  assert.equal(await readFile(markerPath, "utf8"), "SIGTERM\n");
});
