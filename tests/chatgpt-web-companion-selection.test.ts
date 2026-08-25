import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("explicit miuuyy helper override fails closed instead of changing to direct-browser transport", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-miuuyy-explicit-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missingConfig = path.join(root, "missing-miuuyy-config.json");

  assert.throws(
    () => new ChatGptBrowserWebBridge(
      minimalConfig(root),
      path.join(root, "bridge"),
      path.join(root, "state"),
      {
        ...process.env,
        CI: "",
        WCO_CHATGPT_WEB_MIUUYY_CONFIG: missingConfig,
        WCO_CODEX_EXECUTABLE: path.join(root, "must-not-run-codex"),
      },
    ),
    (error: unknown) => (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "WEB_CHATGPT_COMPANION_NOT_CONFIGURED"
    ),
  );
});
