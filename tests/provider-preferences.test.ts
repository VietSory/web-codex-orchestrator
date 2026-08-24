import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TrustedConfig } from "../src/config/contracts.js";
import { ensureChatGptLogin } from "../src/runtime/chatgpt-login.js";
import { productionDoctorProbes } from "../src/orchestration/control-cli.js";
import {
  browserProviderSelected,
  providerPreferencesPath,
  readProviderPreferences,
  readProviderPreferencesSync,
  writeProviderPreferences,
} from "../src/setup/provider-preferences.js";
import { createConfiguredWebBridge } from "../src/web-bridge/bridge-factory.js";
import { ChatGptBrowserWebBridge } from "../src/web-bridge/chatgpt-browser-bridge.js";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";

function config(repositoryPath: string): TrustedConfig {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 100, stable_age_ms: 100, stable_observations: 2, maximum_candidates_per_scan: 10 },
    repositories: {
      fixture: { path: repositoryPath, remote: "origin", expected_remote_urls: ["https://github.com/example/fixture.git"], fetch_policy: "never" },
    },
  };
}

test("provider preference persists direct ChatGPT Web routing without an environment flag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-pref-"));
  try {
    const state = path.join(root, "state");
    const bridge = path.join(root, "bridge");
    await mkdir(state, { recursive: true });
    assert.equal(await readProviderPreferences(state), null);
    assert.equal(browserProviderSelected(state, {}), false);

    await writeProviderPreferences(state, "chatgpt-web");
    assert.deepEqual(await readProviderPreferences(state), { schema_version: "1.0", provider: "chatgpt-web" });
    assert.deepEqual(readProviderPreferencesSync(state), { schema_version: "1.0", provider: "chatgpt-web" });
    assert.equal(browserProviderSelected(state, {}), true);
    assert.ok(createConfiguredWebBridge(config(root), bridge, {}, state) instanceof ChatGptBrowserWebBridge);

    await writeProviderPreferences(state, "codex");
    assert.equal(browserProviderSelected(state, {}), false);
    assert.ok(createConfiguredWebBridge(config(root), bridge, {}, state) instanceof ChatGptCodexWebBridge);
    assert.ok(createConfiguredWebBridge(config(root), bridge, { WCO_CHATGPT_BROWSER: "1" }, state) instanceof ChatGptBrowserWebBridge);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser provider makes legacy Codex login preflight a no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-login-"));
  try {
    const state = path.join(root, "state");
    await mkdir(state, { recursive: true });
    await writeProviderPreferences(state, "chatgpt-web");
    let calls = 0;
    const result = await ensureChatGptLogin({
      config: config(root),
      stateDirectory: state,
      interactive: false,
      runCommand: async () => { calls += 1; return 1; },
    });
    assert.equal(result, true);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PAIR doctor does not require Codex runtime or Codex authentication for saved browser provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-doctor-"));
  try {
    const state = path.join(root, "state");
    await mkdir(state, { recursive: true });
    await writeProviderPreferences(state, "chatgpt-web");
    const probes = productionDoctorProbes({
      stateDirectory: state,
      configPath: path.join(root, "missing-config.json"),
      json: false,
      doctorMode: "PAIR",
      maxTransitions: 8,
    });
    const runtime = probes.find((probe) => probe.id === "codex-runtime");
    const auth = probes.find((probe) => probe.id === "codex-auth");
    assert.ok(runtime);
    assert.ok(auth);
    const runtimeResult = await runtime.run();
    const authResult = await auth.run();
    assert.equal(runtimeResult.severity, "OK");
    assert.match(runtimeResult.summary, /does not require the local Codex runtime/i);
    assert.equal(authResult.severity, "OK");
    assert.match(authResult.summary, /Codex authentication is not required/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed provider preferences fail closed instead of silently spending Codex quota", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-invalid-"));
  try {
    const state = path.join(root, "state");
    await mkdir(state, { recursive: true });
    await writeFile(providerPreferencesPath(state), JSON.stringify({ schema_version: "1.0", provider: "mystery" }));
    assert.throws(() => readProviderPreferencesSync(state), /WCO_PREFERENCES_INVALID/);
    assert.throws(() => browserProviderSelected(state, {}), /WCO_PREFERENCES_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
