import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { resolveTrustedRunContext } from "../src/web-review/trusted-run-context.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture } from "./helpers/phase7-fixtures.js";

async function createConfig(stateDirectory: string): Promise<string> {
  const configPath = path.join(stateDirectory, "phase7-run-bounds-config.json");
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
        path: stateDirectory,
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
  }));
  return fs.realpath(configPath);
}

test("P7-RUN-BOUND-001: canonical Phase 3 run receipt is allocation-bounded before parsing", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-run-bound-")));
  try {
    const fixture = await createPhase6BundleFixture(root);
    const configPath = await createConfig(fixture.stateDirectory);
    const [taskId, archiveSha] = fixture.receipt.run_id.split(":");
    assert.ok(taskId);
    assert.ok(archiveSha);

    const runReceiptPath = path.join(fixture.stateDirectory, "runs", taskId, archiveSha, "run.json");
    await fs.writeFile(runReceiptPath, Buffer.alloc(1_048_577, "x"));

    await assert.rejects(
      () => resolveTrustedRunContext(fixture.receipt.run_id, fixture.stateDirectory, configPath),
      (error: unknown) =>
        error instanceof WebReviewError &&
        error.code === "WEB_REVIEW_RESULT_BUNDLE_INVALID" &&
        error.message.includes("exceeds 1048576 bytes")
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
