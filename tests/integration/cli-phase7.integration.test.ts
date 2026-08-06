import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPhase6BundleFixture, createValidVerdict, TEST_PUBLISHED_COMMIT, TEST_TASK_ID } from "../helpers/phase7-fixtures.js";

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

async function setupRunDirectory(stateDir: string, archiveSha: string, repoPath: string) {
  const runsDir = path.join(stateDir, "runs", TEST_TASK_ID, archiveSha);
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(
    path.join(runsDir, "run.json"),
    JSON.stringify({
      version: "1.0",
      run_id: `${TEST_TASK_ID}:${archiveSha}`,
      task_id: TEST_TASK_ID,
      archive_sha256: archiveSha,
      repository_id: "repo",
      repository_path: repoPath,
      state: "COMPLETED",
    })
  );
}

test("CLI-P7-001 / P7R2-T-036: wco submit-web-verdict approves valid verdict via CLI", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);

    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    const configPath = path.join(tmpDir, "config.json");
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
            path: repoPath,
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

    const res = await runCli([
      "submit-web-verdict",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--config", configPath,
      "--verdict", verdictPath,
      "--json",
    ], { WCO_GITHUB_TOKEN: "mock-token" });

    // Note: since live network call to github.com will fail with auth error in CLI without mock server,
    // the CLI exits with code 3 and outputs one FAILED JSON object (P7R2-T-037).
    assert.equal(res.code, 3);
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.state, "FAILED");
    assert.ok(json.error);
    assert.equal(json.error.code, "WEB_REVIEW_AUTH_ERROR");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI-P7-002 / P7R2-T-037: Compiled missing-token path exits 3 and emits one JSON object", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-missing-token-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);

    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    const configPath = path.join(tmpDir, "config.json");
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
            path: repoPath,
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
