import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WcoBrowserCompanionAgentClient } from "../src/agent/wco-browser-companion-client.js";

const helperSource = String.raw`
const readline = require("node:readline");
const protocolVersion = 1;
const kind = "wco-browser-companion";
process.stdout.write(JSON.stringify({ type: "ready", protocol_version: protocolVersion, kind, pid: process.pid }) + "\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    lines.close();
    process.exit(0);
  }
  if (request.type === "inspect") {
    process.stdout.write(JSON.stringify({
      type: "result",
      id: request.id,
      value: {
        authenticated: true,
        temporary: true,
        url: "https://chatgpt.com/",
        available_modes: ["instant", "medium", "high"],
      },
    }) + "\n");
    return;
  }
  if (request.type === "run") {
    const forbidden = ["workspace_path", "accepted_bundle_path", "repository_path", "bundle_path", "git_dir", "cwd", "command", "cookies", "token", "cdp_endpoint"];
    const leaked = forbidden.find((field) => Object.prototype.hasOwnProperty.call(request, field));
    if (leaked) {
      process.stdout.write(JSON.stringify({ type: "error", id: request.id, code: "TEST_AUTHORITY_LEAK", message: "forbidden field: " + leaked }) + "\n");
      return;
    }
    if (typeof request.prompt !== "string" || !request.prompt.includes("Return exactly one JSON object")) {
      process.stdout.write(JSON.stringify({ type: "error", id: request.id, code: "TEST_PROMPT_INVALID", message: "missing bounded WCO prompt contract" }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ type: "result", id: request.id, text: JSON.stringify({ verdict: "APPROVE" }) }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "error", id: request.id || "unknown", code: "TEST_UNEXPECTED", message: "unexpected request" }) + "\n");
});
`;

test("first-party companion client proves Temporary Chat readiness and keeps WCO authority in WSL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-companion-client-"));
  try {
    const helper = path.join(root, "fake-companion.cjs");
    await writeFile(helper, helperSource, "utf8");
    const client = new WcoBrowserCompanionAgentClient({
      env: { ...process.env, WCO_CHATGPT_WEB_COMPANION_MODE: "high" },
      executable: process.execPath,
      arguments: [helper],
    });

    await client.checkAvailability();
    const turn = await client.turn({
      role: "internal_reviewer",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      prompt: "Review the exact WCO change set and return APPROVE only when it is safe.",
      output_schema: { type: "object", additionalProperties: true },
      read_only: true,
      approval_policy: "never",
      sandbox_mode: "read-only",
      network_access: false,
      live_web_search: false,
      cached_web_search: false,
      workspace_path: "/must-not-cross-into-windows",
      accepted_bundle_path: "/must-not-cross-into-windows/bundle",
    });

    assert.match(turn.thread_id, /^wco-chatgpt-web:/);
    assert.deepEqual(turn.output, { verdict: "APPROVE" });
    assert.deepEqual(turn.usage, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
