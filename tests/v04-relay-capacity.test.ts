import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

test("V04-UX-009 terminal relay history does not consume the active-job quota or its old implicit file cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-capacity-"));
  const store = new RelayFileStore(path.join(root, "relay"), { maximum_active_jobs_per_owner: 1 });
  const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) };
  try {
    for (let index = 0; index < 8; index += 1) {
      const job = await store.create("authoring", "user", { owner: "user", repository, user_intent: `task-${index}`, ttl_seconds: 600, orchestration_mode: "AUTOPILOT" }, `task-${index}`, 600);
      await store.append(job.job_id, "user", "contract_sealed", { envelope: { index } }, `seal-${index}`);
      await store.append(job.job_id, "user", "implementation_sealed", { submission: { index } }, `implementation-${index}`);
    }
    assert.equal((await store.list("user")).length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
