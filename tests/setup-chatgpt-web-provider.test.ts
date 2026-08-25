import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupChatGptWebProviderStatus } from "../src/setup/setup-cli.js";

async function fakeMiuuyyInstall(root: string): Promise<string> {
  const helperScript = path.join(root, "fake-miuuyy-helper.mjs");
  await writeFile(helperScript, `
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
  if (request.type === "inspect") {
    send({ type: "result", id: request.id, value: {
      authenticated: true,
      temporary: true,
      url: "https://chatgpt.com/?temporary-chat=true",
      solAvailable: true,
      proAvailable: false
    }});
  }
});
`, "utf8");

  const descriptorPath = path.join(root, "browser-host.json");
  await writeFile(descriptorPath, JSON.stringify({
    version: 2,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:43101",
    control: { endpoint: "http://127.0.0.1:43102", token: "a".repeat(48) },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "s".repeat(32),
    createdAt: new Date().toISOString()
  }), "utf8");

  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    version: 3,
    releaseVersion: "3.0.3",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    appName: "Codex Native2",
    solAvailable: true,
    proAvailable: false
  }), "utf8");
  return configPath;
}

test("setup readiness uses installed miuuyy helper instead of the legacy direct browser", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-setup-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = await fakeMiuuyyInstall(root);

  const result = await setupChatGptWebProviderStatus(path.join(root, "state"), {
    ...process.env,
    WCO_CHATGPT_WEB_MIUUYY_CONFIG: configPath,
    WCO_CHATGPT_BROWSER_EXECUTABLE: path.join(root, "must-not-launch-browser"),
    WCO_CODEX_EXECUTABLE: path.join(root, "must-not-run-codex"),
  });

  assert.deepEqual(result, {
    value: "ChatGPT Web launcher helper ready",
    transport: "miuuyy-helper",
  });
});

test("setup fails closed on a configured but unavailable helper and does not fall back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-setup-helper-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = await fakeMiuuyyInstall(root);
  const descriptorPath = path.join(root, "browser-host.json");
  const descriptor = JSON.parse(await (await import("node:fs/promises")).readFile(descriptorPath, "utf8"));
  descriptor.helper.script = path.join(root, "missing-helper.mjs");
  await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");

  const result = await setupChatGptWebProviderStatus(path.join(root, "state"), {
    ...process.env,
    WCO_CHATGPT_WEB_MIUUYY_CONFIG: configPath,
    WCO_CHATGPT_BROWSER_EXECUTABLE: path.join(root, "must-not-launch-browser"),
    WCO_CODEX_EXECUTABLE: path.join(root, "must-not-run-codex"),
  });

  assert.deepEqual(result, {
    value: "ChatGPT Web launcher helper sign-in/readiness pending",
    transport: "miuuyy-helper",
  });
});
