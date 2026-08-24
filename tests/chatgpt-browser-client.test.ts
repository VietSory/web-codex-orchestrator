import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChatGptBrowserContextPack, parseChatGptBrowserJson } from "../src/agent/chatgpt-browser-client.js";
import type { TrustedConfig } from "../src/config/contracts.js";
import { createConfiguredWebBridge } from "../src/web-bridge/bridge-factory.js";
import { ChatGptBrowserWebBridge } from "../src/web-bridge/chatgpt-browser-bridge.js";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";

function minimalConfig(repositoryPath: string): TrustedConfig {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 100, stable_age_ms: 100, stable_observations: 2, maximum_candidates_per_scan: 10 },
    repositories: {
      fixture: { path: repositoryPath, remote: "origin", expected_remote_urls: ["https://github.com/example/fixture.git"], fetch_policy: "never" },
    },
  };
}

test("browser JSON parser accepts plain and fenced structured output", () => {
  assert.deepEqual(parseChatGptBrowserJson('{"kind":"ok"}'), { kind: "ok" });
  assert.deepEqual(parseChatGptBrowserJson('```json\n{"kind":"ok"}\n```'), { kind: "ok" });
  assert.deepEqual(parseChatGptBrowserJson('prefix\n{"kind":"ok"}\nsuffix'), { kind: "ok" });
  assert.throws(
    () => parseChatGptBrowserJson("not json"),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "WEB_CHATGPT_BROWSER_OUTPUT_INVALID",
  );
});

test("browser implementation context follows Task Bundle path policy and excludes obvious secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-context-"));
  try {
    const workspace = path.join(root, "workspace");
    const bundle = path.join(root, "bundle");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "infra"), { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(workspace, "src", "worker.ts"), "export const worker = true;\n");
    await writeFile(path.join(workspace, "src", ".env.local"), "SECRET=never-export\n");
    await writeFile(path.join(workspace, "infra", "prod.tf"), "forbidden-file-content\n");
    await writeFile(path.join(workspace, "README.md"), "outside-allowed-content\n");
    await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ allowed_paths: ["src/**"], forbidden_paths: ["src/private/**", "infra/**"] }));
    await writeFile(path.join(bundle, "REQUEST.md"), "Change worker behavior.\n");

    const context = await buildChatGptBrowserContextPack({ workspacePath: workspace, acceptedBundlePath: bundle });
    assert.match(context, /Change worker behavior/);
    assert.match(context, /BEGIN WCO REPOSITORY FILE "src\/worker\.ts"/);
    assert.match(context, /export const worker = true/);
    assert.doesNotMatch(context, /never-export/);
    assert.doesNotMatch(context, /BEGIN WCO REPOSITORY FILE "infra\/prod\.tf"/);
    assert.doesNotMatch(context, /forbidden-file-content/);
    assert.doesNotMatch(context, /BEGIN WCO REPOSITORY FILE "README\.md"/);
    assert.doesNotMatch(context, /outside-allowed-content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser provider flags are explicit and default Codex path stays unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-factory-"));
  try {
    const config = minimalConfig(root);
    const bridgeDirectory = path.join(root, "bridge");
    const stateDirectory = path.join(root, "state");
    const normal = createConfiguredWebBridge(config, bridgeDirectory, {}, stateDirectory);
    const browserOnly = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER: "1" }, stateDirectory);
    const quotaFallback = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER_FALLBACK: "1" }, stateDirectory);
    const both = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER: "1", WCO_CHATGPT_BROWSER_FALLBACK: "1" }, stateDirectory);
    assert.ok(normal instanceof ChatGptCodexWebBridge);
    assert.ok(browserOnly instanceof ChatGptBrowserWebBridge);
    assert.ok(quotaFallback instanceof ChatGptBrowserWebBridge);
    assert.ok(both instanceof ChatGptBrowserWebBridge);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
