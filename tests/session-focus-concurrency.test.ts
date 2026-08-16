import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocalAuthoring } from "../src/web-bridge/local-worker.js";

const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) };

test("two concurrent authoring starts for one repository create only one external job", async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-session-focus-race-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  let createCalls = 0;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const bridge = {
    async createAuthoringJob() {
      createCalls += 1;
      enteredResolve();
      await release;
      return { protocol_version: "wco-web-bridge-v1", job_id: "job-one", owner: "local", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), content_sha256: "b".repeat(64) };
    },
  } as any;

  const first = startLocalAuthoring({ bridge, repository, goal: "first task", stateDirectory });
  await entered;
  const second = startLocalAuthoring({ bridge, repository, goal: "second task", stateDirectory });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(createCalls, 1, "the second process must wait before any external authoring side effect");
  releaseResolve();

  const firstSession = await first;
  assert.equal(firstSession.state, "AUTHORING");
  await assert.rejects(second, (error: any) => error?.code === "WEB_TASK_ALREADY_ACTIVE");
  assert.equal(createCalls, 1, "only the durable current-focus owner may create an authoring job");
});
