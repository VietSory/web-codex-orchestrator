import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WcoBrowserCompanionAgentClient } from "../src/agent/wco-browser-companion-client.js";

async function fixture(root: string): Promise<{ helperPath: string; markerPath: string }> {
  const markerPath = path.join(root, "sigterm.marker");
  const helperPath = path.join(root, "stubborn-helper.cjs");
  await writeFile(helperPath, `
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const keepAlive = setInterval(() => {}, 1000);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.once("SIGTERM", () => {
  fs.writeFileSync(process.env.FAKE_SIGTERM_MARKER, "SIGTERM\\n");
  clearInterval(keepAlive);
  process.exit(0);
});
send({ type: "ready", protocol_version: 1, kind: "wco-browser-companion", pid: process.pid });
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
  return { helperPath, markerPath };
}

async function waitForFile(filePath: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(filePath); return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("first-party companion gives a stubborn helper SIGTERM before forced kill", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-first-party-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { helperPath, markerPath } = await fixture(root);
  const client = new WcoBrowserCompanionAgentClient({
    env: {
      ...process.env,
      WCO_CHATGPT_WEB_COMPANION_MODE: "high",
      WCO_CHATGPT_WEB_COMPANION_TIMEOUT_SECONDS: "8",
      FAKE_SIGTERM_MARKER: markerPath,
    },
    executable: process.execPath,
    arguments: [helperPath],
  });

  const started = Date.now();
  const result = await client.turn({
    role: "final_reviewer",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    prompt: "Return JSON.",
    output_schema: { type: "object" },
    read_only: true,
    approval_policy: "never",
    sandbox_mode: "read-only",
    network_access: false,
    live_web_search: false,
    cached_web_search: false,
    workspace_path: "/must-stay-in-wsl/workspace",
    accepted_bundle_path: "/must-stay-in-wsl/bundle",
  });
  assert.deepEqual(result.output, { ok: true });
  assert.ok(Date.now() - started >= 1_500, "stubborn helper should receive the graceful shutdown window");
  assert.ok(Date.now() - started < 7_000, "staged shutdown must remain bounded");
  await waitForFile(markerPath);
  assert.equal(await readFile(markerPath, "utf8"), "SIGTERM\n");
});
