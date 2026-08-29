import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupChatGptWebProviderStatus } from "../src/setup/setup-cli.js";

async function fakeWcoCompanion(root: string): Promise<string> {
  const executable = path.join(root, "fake-wco-browser-companion");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready", protocol_version: 1, kind: "wco-browser-companion", pid: process.pid });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    input.close();
    setImmediate(() => process.exit(0));
    return;
  }
  if (request.type === "inspect") {
    send({ type: "result", id: request.id, value: {
      authenticated: true,
      temporary: true,
      url: "https://chatgpt.com/?temporary-chat=true",
      available_modes: ["instant", "medium", "high"]
    }});
  }
});
`, { encoding: "utf8", mode: 0o700 });
  return executable;
}

test("setup readiness uses the explicit first-party WCO companion and never a legacy transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-setup-first-party-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fakeWcoCompanion(root);
  const codexMarker = path.join(root, "codex-must-not-run.marker");
  const fakeCodex = path.join(root, "fake-codex.sh");
  await writeFile(fakeCodex, `#!/bin/sh\nprintf codex > ${JSON.stringify(codexMarker)}\nexit 99\n`, { mode: 0o700 });

  const result = await setupChatGptWebProviderStatus(path.join(root, "state"), {
    ...process.env,
    CI: "true",
    WCO_CHATGPT_WEB_COMPANION_EXECUTABLE: executable,
    WCO_CHATGPT_BROWSER_EXECUTABLE: path.join(root, "must-not-launch-legacy-browser"),
    WCO_CODEX_EXECUTABLE: fakeCodex,
  });

  assert.deepEqual(result, {
    value: "WCO ChatGPT Web browser companion ready",
    transport: "wco-companion",
  });
  assert.equal(existsSync(codexMarker), false, "setup readiness must never execute Codex for browser PAIR");
});

test("setup fails closed on a missing first-party companion and does not fall back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-setup-first-party-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexMarker = path.join(root, "codex-must-not-run.marker");
  const fakeCodex = path.join(root, "fake-codex.sh");
  await writeFile(fakeCodex, `#!/bin/sh\nprintf codex > ${JSON.stringify(codexMarker)}\nexit 99\n`, { mode: 0o700 });

  const result = await setupChatGptWebProviderStatus(path.join(root, "state"), {
    ...process.env,
    CI: "true",
    WCO_CHATGPT_WEB_COMPANION_EXECUTABLE: path.join(root, "missing-wco-companion.exe"),
    WCO_CHATGPT_BROWSER_EXECUTABLE: path.join(root, "must-not-launch-legacy-browser"),
    WCO_CODEX_EXECUTABLE: fakeCodex,
  });

  assert.deepEqual(result, {
    value: "WCO ChatGPT Web browser companion sign-in/readiness pending",
    transport: "wco-companion",
  });
  assert.equal(existsSync(codexMarker), false, "missing companion must fail closed without Codex fallback");
});
