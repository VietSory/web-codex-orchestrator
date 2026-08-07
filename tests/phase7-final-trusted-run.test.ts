import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { resolveTrustedRunContext } from "../src/web-review/trusted-run-context.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, TEST_ARCHIVE_SHA, TEST_TASK_ID } from "./helpers/phase7-fixtures.js";

async function createTestConfig(stateDir: string): Promise<string> {
  const configPath = path.join(stateDir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
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
  }));
  return fs.realpath(configPath);
}

async function readCanonicalRun(stateDir: string): Promise<{ runPath: string; run: Record<string, unknown> }> {
  const runPath = path.join(stateDir, "runs", TEST_TASK_ID, TEST_ARCHIVE_SHA, "run.json");
  return { runPath, run: JSON.parse(await fs.readFile(runPath, "utf8")) as Record<string, unknown> };
}

test("P7-FINAL-006: canonical run receipt must contain remote identity", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-remote-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const { runPath, run } = await readCanonicalRun(fixture.stateDirectory);
    delete run.remote;
    delete run.remote_url;
    await fs.writeFile(runPath, JSON.stringify(run));

    await assert.rejects(
      () => resolveTrustedRunContext(fixture.receipt.run_id, fixture.stateDirectory, configPath),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_RESULT_BUNDLE_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-FINAL-007: canonical run remote URL must belong to the trusted registry", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-remote-drift-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const { runPath, run } = await readCanonicalRun(fixture.stateDirectory);
    run.remote_url = "https://github.com/attacker/other-repo";
    await fs.writeFile(runPath, JSON.stringify(run));

    await assert.rejects(
      () => resolveTrustedRunContext(fixture.receipt.run_id, fixture.stateDirectory, configPath),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
