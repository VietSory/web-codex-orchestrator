import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTrustedRunContext } from "../src/web-review/trusted-run-context.js";
import { WebReviewError } from "../src/web-review/contracts.js";

const TASK = "P8-STATE-OWNER";
const SHA = "1".repeat(64);
const RUN_ID = `${TASK}:${SHA}`;

test("P8-MAINT-008: canonical run receipt cannot redirect Phase 8 worktree outside state storage", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-state-owner-")));
  try {
    const state = path.join(root, "state");
    const externalWorktree = path.join(root, "outside-worktree");
    const runDir = path.join(state, "runs", TASK, SHA);
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(externalWorktree, { recursive: true });
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({
      run_version: "1.0",
      run_id: RUN_ID,
      task_id: TASK,
      archive_sha256: SHA,
      repository_id: "repo",
      repository_path: externalWorktree,
      remote: "origin",
      remote_url: "https://github.com/owner/repo",
      worktree_path: externalWorktree,
      accepted_bundle_path: path.join(state, "accepted", TASK, SHA),
    }));

    await assert.rejects(
      () => resolveTrustedRunContext(RUN_ID, state, path.join(root, "unused-config.json")),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT" && error.message.includes("worktree") && error.message.includes("state root")
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
