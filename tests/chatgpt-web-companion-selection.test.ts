import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptBrowserWebBridge } from "../src/web-bridge/chatgpt-browser-bridge.js";

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

test("missing first-party companion fails closed without direct-browser or Codex fallback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-first-party-explicit-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missingCompanion = path.join(root, "missing-wco-companion.exe");
  const codexMarker = path.join(root, "codex-must-not-run.marker");
  const fakeCodex = path.join(root, "fake-codex.sh");
  await writeFile(fakeCodex, `#!/bin/sh\nprintf codex > ${JSON.stringify(codexMarker)}\nexit 99\n`, { mode: 0o700 });

  const bridge = new ChatGptBrowserWebBridge(
    minimalConfig(root),
    path.join(root, "bridge"),
    path.join(root, "state"),
    {
      ...process.env,
      CI: "",
      WCO_CHATGPT_WEB_COMPANION_EXECUTABLE: missingCompanion,
      WCO_CODEX_EXECUTABLE: fakeCodex,
    },
  );

  const status = await bridge.getConnectionStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.equal(existsSync(codexMarker), false, "browser PAIR readiness must never execute the Codex fallback");
});
