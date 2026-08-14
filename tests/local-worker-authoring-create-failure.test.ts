import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeWebBridge } from "../src/web-bridge/fake-web-bridge.js";
import { readLocalWorkerSession, startLocalAuthoring } from "../src/web-bridge/local-worker.js";

const repository = {
  repository_id: "repo",
  base_branch: "main",
  base_commit: "a".repeat(40),
};

test("failed bridge/auth creation marks the local recovery anchor BLOCKED so the next normal goal is not trapped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-author-create-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const failing = new FakeWebBridge();
  (failing as any).createAuthoringJob = async () => { throw new Error("official ChatGPT authorization cancelled"); };

  await assert.rejects(
    () => startLocalAuthoring({ bridge: failing, repository, goal: "first goal", stateDirectory: root }),
    /authorization cancelled/,
  );
  const blocked = await readLocalWorkerSession(root, repository.repository_id);
  assert.equal(blocked?.state, "BLOCKED");
  assert.equal(blocked?.job_id, null);
  assert.equal(blocked?.goal, "first goal");

  const healthy = new FakeWebBridge();
  const next = await startLocalAuthoring({ bridge: healthy, repository, goal: "retry goal", stateDirectory: root });
  assert.equal(next.state, "AUTHORING");
  assert.ok(next.job_id);
  assert.equal(next.goal, "retry goal");
});
