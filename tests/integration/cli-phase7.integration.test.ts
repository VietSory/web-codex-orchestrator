import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPhase6BundleFixture, createValidVerdict, TEST_RUN_ID } from "../helpers/phase7-fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "..", "dist", "cli", "index.js");

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI_PATH, ...args], (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

test("CLI-P7-001: wco submit-web-verdict approves valid verdict via CLI", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
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
            path: tmpDir,
            remote: "origin",
            expected_remote_urls: ["https://github.com/owner/repo"],
            fetch_policy: "never",
          },
        },
        result_bundle: {
          maximum_entries: 1000,
          maximum_entry_bytes: 1048576,
          maximum_total_uncompressed_bytes: 5242880,
          maximum_archive_bytes: 2097152,
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
    ]);

    assert.equal(res.code, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.state, "APPROVED");
    assert.equal(json.action, "ASK_USER_TO_MERGE");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI-P7-002: wco web-review-status returns review status via CLI", async () => {
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-cli-"));
  tmpDir = await fs.realpath(tmpDir);
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
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
            path: tmpDir,
            remote: "origin",
            expected_remote_urls: ["https://github.com/owner/repo"],
            fetch_policy: "never",
          },
        },
        result_bundle: {
          maximum_entries: 1000,
          maximum_entry_bytes: 1048576,
          maximum_total_uncompressed_bytes: 5242880,
          maximum_archive_bytes: 2097152,
        },
      })
    );

    await runCli([
      "submit-web-verdict",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--config", configPath,
      "--verdict", verdictPath,
    ]);

    const res = await runCli([
      "web-review-status",
      "--run-id", fixture.receipt.run_id,
      "--state-dir", fixture.stateDirectory,
      "--json",
    ]);

    assert.equal(res.code, 0);
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.state, "APPROVED");
    assert.equal(json.review_round, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
