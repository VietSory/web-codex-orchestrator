import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunLedger, writeRunLedger } from "../src/orchestration/ledger.js";
import { readLocalWorkerSession, type LocalWorkerSession } from "../src/web-bridge/local-worker.js";
import { restoreLocalTaskHistoryFocus } from "../src/web-bridge/session-history.js";

function durableSession(state: string, taskArchive: string, webPack: string): LocalWorkerSession {
  const repository = { repository_id: "repo", base_branch: "main", base_commit: "b".repeat(40) };
  return {
    schema_version: "1.0",
    session_id: "11111111-1111-4111-8111-111111111111",
    repository,
    goal: "resume the exact saved task",
    job_mode: "PAIR",
    job_id: "job-resume-1",
    last_event_sequence: 3,
    sealed: true,
    contract: {
      protocol_version: "wco-web-bridge-v1",
      job_id: "job-resume-1",
      repository,
      user_intent: "resume the exact saved task",
      title: "Resume task",
      goal: "resume the exact saved task",
      non_goals: [],
      architecture_decisions: ["preserve durable authority"],
      allowed_paths: ["src/**"],
      forbidden_paths: [],
      acceptance_criteria: [{ id: "AC-1", description: "saved task resumes safely" }],
      verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
      risk_policy: { network_access: false, secrets_required: false, notes: [] },
      delivery: { remote: "origin", base_branch: "main", branch_name: "wco/resume", draft: true, auto_merge: false },
      sources: [],
      implementation_strategy: ["continue exact run"],
      project_map_hints: [],
    },
    task_archive_path: taskArchive,
    run_id: `TASK-RESUME:${"a".repeat(64)}`,
    web_pack_path: webPack,
    state: state as LocalWorkerSession["state"],
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:01:00.000Z",
  };
}

test("history resume re-attests the durable ledger and artifacts before changing current focus", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-history-resume-"));
  const artifacts = path.join(state, "resume-artifacts");
  await mkdir(artifacts, { recursive: true });
  const taskArchive = path.join(artifacts, "task-bundle.zip");
  const webPack = path.join(artifacts, "web-pack.zip");
  await Promise.all([writeFile(taskArchive, "task"), writeFile(webPack, "pack")]);
  const session = durableSession("IMPLEMENTATION_REGISTERED", taskArchive, webPack);
  await writeRunLedger(state, createRunLedger({ runId: session.run_id! }));

  const restored = await restoreLocalTaskHistoryFocus(state, "repo", session);
  assert.equal(restored.session_id, session.session_id);
  assert.ok(Date.parse(restored.updated_at) > Date.parse(session.updated_at));
  const current = await readLocalWorkerSession(state, "repo");
  assert.equal(current?.run_id, session.run_id);
  assert.equal(current?.goal, session.goal);
});

test("history resume refuses authoring-only history instead of inventing local authority", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-history-authoring-only-"));
  const artifacts = path.join(state, "resume-artifacts");
  await mkdir(artifacts, { recursive: true });
  const taskArchive = path.join(artifacts, "task-bundle.zip");
  const webPack = path.join(artifacts, "web-pack.zip");
  await Promise.all([writeFile(taskArchive, "task"), writeFile(webPack, "pack")]);
  const session = durableSession("AUTHORING", taskArchive, webPack);
  session.sealed = false;
  session.contract = null;
  session.task_archive_path = null;
  session.run_id = null;
  session.web_pack_path = null;

  await assert.rejects(restoreLocalTaskHistoryFocus(state, "repo", session), /NOT_RESUMABLE|implementation checkpoint/i);
  assert.equal(await readLocalWorkerSession(state, "repo"), null);
});

test("history resume refuses symlinked durable artifacts", { skip: process.platform === "win32" }, async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-history-symlink-"));
  const artifacts = path.join(state, "resume-artifacts");
  await mkdir(artifacts, { recursive: true });
  const realTask = path.join(artifacts, "real-task.zip");
  const taskArchive = path.join(artifacts, "task-bundle.zip");
  const webPack = path.join(artifacts, "web-pack.zip");
  await Promise.all([writeFile(realTask, "task"), writeFile(webPack, "pack")]);
  await symlink(realTask, taskArchive);
  const session = durableSession("IMPLEMENTATION_REGISTERED", taskArchive, webPack);
  await writeRunLedger(state, createRunLedger({ runId: session.run_id! }));

  await assert.rejects(restoreLocalTaskHistoryFocus(state, "repo", session), /non-symlink|redirected path/i);
  assert.equal(await readLocalWorkerSession(state, "repo"), null);
});
