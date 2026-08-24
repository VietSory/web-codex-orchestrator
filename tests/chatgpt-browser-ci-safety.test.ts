import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { writeProviderPreferences } from "../src/setup/provider-preferences.js";
import { ChatGptBrowserWebBridge } from "../src/web-bridge/chatgpt-browser-bridge.js";
import { runWebCommand } from "../src/web-bridge/web-cli.js";

function minimalConfig(repoPath: string): any {
  return {
    config_version: "1.0",
    inbox: {
      poll_interval_ms: 2_000,
      stable_age_ms: 3_000,
      stable_observations: 2,
      maximum_candidates_per_scan: 100,
    },
    repositories: {
      repo: {
        path: repoPath,
        remote: "origin",
        expected_remote_urls: ["https://github.com/example/repo.git"],
        fetch_policy: "never",
      },
    },
    runtime: { source: "bundled" },
  };
}

test("ChatGPT browser connection status never launches a real browser in CI", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-ci-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bridge = new ChatGptBrowserWebBridge(
    minimalConfig(root),
    path.join(root, "bridge"),
    path.join(root, "state"),
    {
      ...process.env,
      CI: "true",
      WCO_CHATGPT_BROWSER_EXECUTABLE: path.join(root, "must-not-run-browser"),
    },
  );

  const status = await bridge.getConnectionStatus();
  assert.deepEqual(status, {
    configured: true,
    connected: false,
    account: "CI browser probe disabled",
  });
});

test("web status reports saved ChatGPT Web provider without legacy Codex UX in CI", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-ci-web-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeTrustedConfigAtomic(path.join(root, "config.json"), minimalConfig(repo));
  await writeProviderPreferences(path.join(root, "state"), "chatgpt-web");

  const previousHome = process.env.WCO_HOME;
  const previousCi = process.env.CI;
  process.env.WCO_HOME = root;
  process.env.CI = "true";
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runWebCommand(["status"], {
      write: (value) => stdout.push(value),
      error: (value) => stderr.push(value),
    });
    const output = stdout.join("");

    assert.equal(code, 1);
    assert.match(output, /Mode\s+ChatGPT Web browser PAIR/);
    assert.match(output, /ChatGPT Web session\s+not ready/);
    assert.match(output, /Codex provider quota\s+not required for PAIR/);
    assert.match(output, /Browser readiness\s+CI probe disabled; run locally/);
    assert.doesNotMatch(output, /Mode\s+local ChatGPT\/Codex/);
    assert.equal(stderr.join(""), "");
  } finally {
    if (previousHome === undefined) delete process.env.WCO_HOME;
    else process.env.WCO_HOME = previousHome;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
});
