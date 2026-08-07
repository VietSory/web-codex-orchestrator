import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPhase6BundleFixture,
  createValidVerdict,
  TEST_BASE_COMMIT,
  TEST_PUBLISHED_COMMIT,
} from "../helpers/phase7-fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "..", "dist", "cli", "index.js");

function runCli(args: string[], envOverrides?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI_PATH, ...args], { env: { ...process.env, ...envOverrides } }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function createConfig(stateDir: string): Promise<string> {
  const configPath = path.join(stateDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      config_version: "1.0",
      inbox: {
        poll_interval_ms: 1000,
        stable_age_ms: 1000,
        stable_observations: 1,
        maximum_candidates_per_scan: 1,
      },
      repositories: {
        repo: {
          path: stateDir,
          remote: "origin",
          expected_remote_urls: ["https://github.com/owner/repo"],
          fetch_policy: "never",
        },
      },
      github_pull_request: {
        provider: "github.com",
        authentication: {
          mode: "https_token",
          token_environment_key: "WCO_GITHUB_TOKEN",
        },
      },
    })
  );
  return fs.realpath(configPath);
}

async function createFetchPreloader(tmpDir: string): Promise<string> {
  const responsePayload = JSON.stringify({
    number: 101,
    state: "open",
    draft: true,
    merged: false,
    html_url: "https://github.com/owner/repo/pull/101",
    head: {
      ref: "codex/feature",
      sha: TEST_PUBLISHED_COMMIT,
      repo: { full_name: "owner/repo" },
    },
    base: {
      ref: "main",
      sha: TEST_BASE_COMMIT,
      repo: { full_name: "owner/repo" },
    },
  });
  const preloadPath = path.join(tmpDir, "mock-github-fetch.mjs");
  await fs.writeFile(
    preloadPath,
    `const payload = ${JSON.stringify(responsePayload)};\n` +
      `globalThis.fetch = async () => new Response(payload, { status: 200, headers: { "content-length": String(Buffer.byteLength(payload)) } });\n`
  );
  return pathToFileURL(preloadPath).href;
}

test("CLI-P7-001: compiled submit-web-verdict reaches APPROVED on a valid Draft PR", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-approve-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));
    const configPath = await createConfig(fixture.stateDirectory);
    const preloadUrl = await createFetchPreloader(tmpDir);

    const res = await runCli([
      "submit-web-verdict",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--config", configPath,
      "--verdict", verdictPath,
      "--json",
    ], {
      WCO_GITHUB_TOKEN: "mock-token",
      NODE_OPTIONS: `--import=${preloadUrl}`,
    });

    assert.equal(res.code, 0, res.stderr || res.stdout);
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.state, "APPROVED");
    assert.equal(json.action, "ASK_USER_TO_MERGE");
    assert.equal(json.fresh_attested_head_sha, TEST_PUBLISHED_COMMIT);

    const status = await runCli([
      "web-review-status",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--round", "1",
      "--json",
    ]);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    const statusJson = JSON.parse(status.stdout.trim());
    assert.equal(statusJson.state, "APPROVED");
    assert.equal(statusJson.verdict_sha256, json.verdict_sha256);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI-P7-002: compiled missing-token path exits 3 and emits one JSON object", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-missing-token-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));
    const configPath = await createConfig(fixture.stateDirectory);

    const res = await runCli([
      "submit-web-verdict",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--config", configPath,
      "--verdict", verdictPath,
      "--json",
    ], { WCO_GITHUB_TOKEN: "" });

    assert.equal(res.code, 3);
    const lines = res.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const json = JSON.parse(lines[0]!);
    assert.equal(json.state, "FAILED");
    assert.equal(json.error.code, "WEB_REVIEW_AUTH_ERROR");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
