import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserLifecycle, buildChatGptBrowserContextPack, detectWslNetworkingMode, parseChatGptBrowserJson, resolveBrowserProfilePlan } from "../src/agent/chatgpt-browser-client.js";
import type { TrustedConfig } from "../src/config/contracts.js";
import { writeProviderPreferences } from "../src/setup/provider-preferences.js";
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

test("browser provider is the safe default and Codex requires an explicit persisted selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-factory-"));
  try {
    const config = minimalConfig(root);
    const bridgeDirectory = path.join(root, "bridge");
    const stateDirectory = path.join(root, "state");
    const normal = createConfiguredWebBridge(config, bridgeDirectory, {}, stateDirectory);
    const browser = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER: "1" }, stateDirectory);
    const obsoleteFallbackFlag = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER_FALLBACK: "1" }, stateDirectory);
    assert.ok(normal instanceof ChatGptBrowserWebBridge);
    assert.ok(browser instanceof ChatGptBrowserWebBridge);
    assert.ok(obsoleteFallbackFlag instanceof ChatGptBrowserWebBridge);

    await writeProviderPreferences(stateDirectory, "codex");
    const explicitCodex = createConfiguredWebBridge(config, bridgeDirectory, {}, stateDirectory);
    const browserOverride = createConfiguredWebBridge(config, bridgeDirectory, { WCO_CHATGPT_BROWSER: "1" }, stateDirectory);
    assert.ok(explicitCodex instanceof ChatGptCodexWebBridge);
    assert.ok(browserOverride instanceof ChatGptBrowserWebBridge);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser profile planning keeps native browsers on their native state filesystem", () => {
  const tools = {
    toWindows: () => { throw new Error("native browser must not invoke wslpath"); },
    toLinux: () => { throw new Error("native browser must not invoke wslpath"); },
    windowsLocalAppData: () => { throw new Error("native browser must not discover Windows paths"); },
  };
  const linux = resolveBrowserProfilePlan({ stateDirectory: "/tmp/wco", executable: "/usr/bin/chromium", tools, platform: "linux" });
  assert.deepEqual(linux, { linux_profile_path: "/tmp/wco/chatgpt-browser/profile", browser_profile_path: "/tmp/wco/chatgpt-browser/profile", cross_os: false });
  const windows = resolveBrowserProfilePlan({ stateDirectory: "/state/wco", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", tools, platform: "win32" });
  assert.equal(windows.cross_os, false);
  assert.equal(windows.browser_profile_path, windows.linux_profile_path);
});

test("WSL Windows Chrome derives a dedicated Windows profile for Linux-only WCO state", () => {
  const plan = resolveBrowserProfilePlan({
    stateDirectory: "/tmp/wco-state",
    executable: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    platform: "linux",
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    tools: {
      toWindows: (value) => value.startsWith("/tmp/") ? "\\\\wsl.localhost\\Ubuntu\\tmp\\wco-state" : null,
      toLinux: (value) => value.startsWith("C:\\Users\\WcoUser\\AppData\\Local\\WCO\\chatgpt-browser\\") ? "/mnt/c/Users/WcoUser/AppData/Local/WCO/chatgpt-browser/profile-key" : null,
      windowsLocalAppData: () => "C:\\Users\\WcoUser\\AppData\\Local",
    },
  });
  assert.equal(plan.cross_os, true);
  assert.match(plan.browser_profile_path, /^C:\\Users\\WcoUser\\AppData\\Local\\WCO\\chatgpt-browser\\[a-f0-9]{32}$/);
  assert.equal(plan.linux_profile_path, "/mnt/c/Users/WcoUser/AppData/Local/WCO/chatgpt-browser/profile-key");
});

test("WSL Windows Chrome retains a mounted Windows state profile and rejects an explicit Linux-only profile", () => {
  const tools = {
    toWindows: (value: string) => value.startsWith("/mnt/d/") ? `D:${value.slice("/mnt/d".length).replaceAll("/", "\\")}` : "\\\\wsl.localhost\\Ubuntu\\tmp\\profile",
    toLinux: (value: string) => value.startsWith("D:\\") ? `/mnt/d${value.slice(2).replaceAll("\\", "/")}` : null,
    windowsLocalAppData: () => "C:\\Users\\WcoUser\\AppData\\Local",
  };
  const mounted = resolveBrowserProfilePlan({ stateDirectory: "/mnt/d/wco-state", executable: "/mnt/c/Chrome/chrome.exe", tools, platform: "linux", environment: { WSL_INTEROP: "1" } });
  assert.deepEqual(mounted, { linux_profile_path: "/mnt/d/wco-state/chatgpt-browser/profile", browser_profile_path: "D:\\wco-state\\chatgpt-browser\\profile", cross_os: true });
  assert.throws(
    () => resolveBrowserProfilePlan({ stateDirectory: "/tmp/wco-state", configuredProfile: "/tmp/profile", executable: "/mnt/c/Chrome/chrome.exe", tools, platform: "linux", environment: { WSL_INTEROP: "1" } }),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "WEB_CHATGPT_BROWSER_WSL_PROFILE_UNTRANSLATABLE",
  );
});

test("browser lifecycle closes CDP and terminates only its own child idempotently", async () => {
  let closed = 0, killed = 0;
  let exited: (() => void) | undefined;
  const lifecycle = new BrowserLifecycle();
  lifecycle.setConnection({ close: () => { closed += 1; } });
  lifecycle.own({
    exitCode: null,
    kill: () => { killed += 1; queueMicrotask(() => exited?.()); return true; },
    once: (_event, listener) => { exited = listener; return undefined as never; },
  });
  await lifecycle.close();
  await lifecycle.close();
  assert.equal(closed, 1);
  assert.equal(killed, 1);

  const existing = new BrowserLifecycle();
  existing.setConnection({ close: () => { closed += 1; } });
  await existing.close();
  assert.equal(closed, 2, "an existing compatible browser is disconnected but never killed");

  let windowsTreeKills = 0, fallbackKills = 0;
  const windowsInterop = new BrowserLifecycle();
  windowsInterop.own({ exitCode: null, kill: () => { fallbackKills += 1; return true; }, once: () => undefined as never }, () => { windowsTreeKills += 1; });
  await windowsInterop.close();
  await windowsInterop.close();
  assert.equal(windowsTreeKills, 1, "Windows interop uses its exact owned-tree terminator once");
  assert.equal(fallbackKills, 0, "Windows interop does not rely on the ineffective Linux child signal");
});

test("WSL networking diagnostics distinguish mirrored mode, NAT default, and unavailable host configuration", () => {
  assert.equal(detectWslNetworkingMode("[wsl2]\nnetworkingMode=mirrored\n"), "mirrored");
  assert.equal(detectWslNetworkingMode("[wsl2]\nmemory=4GB\n"), "nat");
  assert.equal(detectWslNetworkingMode(null), "unknown");
});
