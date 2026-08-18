import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
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

test("explicit task replacement aborts before provider work when confirmed current focus changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-focus-confirmation-"));
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });

  const firstBridge = new FakeWebBridge();
  const first = await startLocalAuthoring({
    bridge: firstBridge,
    repository,
    goal: "first task",
    stateDirectory: state,
  });

  const secondBridge = new FakeWebBridge();
  await assert.rejects(
    startLocalAuthoring({
      bridge: secondBridge,
      repository,
      goal: "replacement task",
      stateDirectory: state,
      replaceExplicit: true,
      expectedCurrentSessionId: null,
    }),
    /current repository task focus changed after confirmation/i,
  );

  const current = await readLocalWorkerSession(state, repository.repository_id);
  assert.equal(current?.session_id, first.session_id);
  assert.equal(current?.goal, "first task");
});

test("explicit task replacement succeeds only when the confirmed exact session still owns focus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-focus-confirmation-ok-"));
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });

  const first = await startLocalAuthoring({
    bridge: new FakeWebBridge(),
    repository,
    goal: "first task",
    stateDirectory: state,
  });
  const replacement = await startLocalAuthoring({
    bridge: new FakeWebBridge(),
    repository,
    goal: "replacement task",
    stateDirectory: state,
    replaceExplicit: true,
    expectedCurrentSessionId: first.session_id,
  });

  assert.notEqual(replacement.session_id, first.session_id);
  const current = await readLocalWorkerSession(state, repository.repository_id);
  assert.equal(current?.session_id, replacement.session_id);
  assert.equal(current?.goal, "replacement task");
});
