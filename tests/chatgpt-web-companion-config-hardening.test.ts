import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptWebCompanionAgentClient } from "../src/agent/chatgpt-web-companion-client.js";
import { PINNED_MIUUYY_CHATGPT_WEB_RELEASE } from "../src/agent/chatgpt-web-companion-protocol.js";

async function writeInstalledConfig(root: string, overrides: Record<string, unknown>): Promise<string> {
  const configPath = path.join(root, "config.json");
  const config: Record<string, unknown> = {
    version: 3,
    releaseVersion: PINNED_MIUUYY_CHATGPT_WEB_RELEASE,
    browserHost: "launcher",
    browserHostDescriptorPath: path.join(root, "descriptor-not-needed.json"),
    appName: "Codex Native2",
    solAvailable: true,
    proAvailable: false,
    ...overrides,
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function assertConfigInvalid(configPath: string): void {
  assert.throws(
    () => new ChatGptWebCompanionAgentClient({
      env: {
        ...process.env,
        WCO_CHATGPT_WEB_MIUUYY_CONFIG: configPath,
        WCO_CHATGPT_WEB_COMPANION_MODE: "high",
      },
    }),
    (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_CONFIG_INVALID"
    ),
  );
}

test("companion fails closed when solAvailable is not an explicit boolean", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-config-sol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = await writeInstalledConfig(root, { solAvailable: "true" });
  assertConfigInvalid(configPath);
});

test("companion fails closed when proAvailable is not an explicit boolean", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-config-pro-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = await writeInstalledConfig(root, { proAvailable: 0 });
  assertConfigInvalid(configPath);
});
