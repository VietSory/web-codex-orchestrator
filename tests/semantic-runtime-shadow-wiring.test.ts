import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { semanticShadowReceiptPath } from "../src/semantic/shadow-observer.js";
import { type RepositoryCommandResult } from "../src/web-bridge/contracts.js";
import { FakeWebBridge } from "../src/web-bridge/fake-web-bridge.js";
import { advanceLocalWorker, readLocalWorkerSession, type LocalWorkerSession } from "../src/web-bridge/local-worker.js";

const run = promisify(execFile);

async function repository(root: string): Promise<{ repo: string; base: string }> {
  const repo = path.join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["config", "user.name", "Test"], { cwd: repo });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "semantic shadow source bytes\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return { repo, base };
}

function session(base: string): LocalWorkerSession {
  const now = "2026-08-16T00:00:00.000Z";
  return {
    schema_version: "1.0",
    session_id: "11111111-1111-4111-8111-111111111111",
    repository: { repository_id: "repo", base_branch: "main", base_commit: base },
    goal: "inspect repository",
    job_id: "job-runtime-shadow",
    last_event_sequence: 0,
    sealed: false,
    contract: null,
    task_archive_path: null,
    run_id: null,
    web_pack_path: null,
    state: "AUTHORING",
    created_at: now,
    updated_at: now,
  };
}

class InspectingBridge extends FakeWebBridge {
  constructor(private readonly onSubmit?: (result: RepositoryCommandResult) => Promise<void> | void) { super(); }

  override async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult): Promise<void> {
    await this.onSubmit?.(result);
    await super.submitRepositoryCommandResult(jobId, result);
  }
}

const config = {} as any;

test("runtime shadow persists only after the exact repository result has been delivered to Web", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-runtime-shadow-order-"));
  try {
    const { repo, base } = await repository(root);
    const stateDirectory = path.join(root, "state");
    const current = session(base);
    const receiptPath = semanticShadowReceiptPath({
      stateDirectory,
      repositoryId: "repo",
      sessionId: current.session_id,
      eventSequence: 1,
      requestId: "read-1",
    });
    let submitObserved = false;
    const bridge = new InspectingBridge(async (result) => {
      submitObserved = true;
      assert.equal(result.request_id, "read-1");
      await assert.rejects(() => readFile(receiptPath), /ENOENT/);
    });
    bridge.enqueue(current.job_id!, {
      sequence: 1,
      type: "repository_command",
      request_id: "read-1",
      command: { operation: "read", paths: ["app.txt"] },
    });

    const advanced = await advanceLocalWorker({
      bridge,
      session: current,
      repositoryPath: repo,
      stateDirectory,
      configPath: path.join(root, "unused-config.json"),
      config,
      maximumEvents: 1,
    });

    assert.equal(submitObserved, true);
    assert.equal(bridge.repositoryResults.length, 1);
    assert.equal(advanced.last_event_sequence, 1);
    const receiptText = await readFile(receiptPath, "utf8");
    assert.match(receiptText, /wco-semantic-shadow-observation/);

    const persisted = await readLocalWorkerSession(stateDirectory, "repo");
    assert.equal(persisted?.last_event_sequence, 1);
    assert.equal(persisted?.state, "AUTHORING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production shadow persistence failure cannot block Web context delivery or authoring checkpoint progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-runtime-shadow-fail-"));
  try {
    const { repo, base } = await repository(root);
    const stateDirectory = path.join(root, "state");
    await mkdir(path.join(stateDirectory, "bridge"), { recursive: true });
    await writeFile(path.join(stateDirectory, "bridge", "semantic-shadow"), "block observer directory creation\n");

    const bridge = new InspectingBridge();
    const current = session(base);
    bridge.enqueue(current.job_id!, {
      sequence: 1,
      type: "repository_command",
      request_id: "tree-1",
      command: { operation: "tree", maximum_paths: 8 },
    });

    const advanced = await advanceLocalWorker({
      bridge,
      session: current,
      repositoryPath: repo,
      stateDirectory,
      configPath: path.join(root, "unused-config.json"),
      config,
      maximumEvents: 1,
    });

    assert.equal(bridge.repositoryResults.length, 1);
    assert.equal(bridge.repositoryResults[0]?.request_id, "tree-1");
    assert.equal(advanced.last_event_sequence, 1);
    const persisted = await readLocalWorkerSession(stateDirectory, "repo");
    assert.equal(persisted?.last_event_sequence, 1);
    assert.equal(persisted?.state, "AUTHORING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default runtime shadow strips source bytes while preserving digest-bound read evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-runtime-shadow-bytes-"));
  try {
    const { repo, base } = await repository(root);
    const stateDirectory = path.join(root, "state");
    const bridge = new InspectingBridge();
    const current = session(base);
    bridge.enqueue(current.job_id!, {
      sequence: 7,
      type: "repository_command",
      request_id: "read-7",
      command: { operation: "read", paths: ["app.txt"] },
    });

    const advanced = await advanceLocalWorker({
      bridge,
      session: current,
      repositoryPath: repo,
      stateDirectory,
      configPath: path.join(root, "unused-config.json"),
      config,
      maximumEvents: 1,
    });

    assert.equal(advanced.last_event_sequence, 7);
    assert.equal(bridge.repositoryResults.length, 1);
    const relayPayload = JSON.stringify(bridge.repositoryResults[0]);
    assert.match(relayPayload, /content_base64/);

    const receiptPath = semanticShadowReceiptPath({
      stateDirectory,
      repositoryId: "repo",
      sessionId: current.session_id,
      eventSequence: 7,
      requestId: "read-7",
    });
    const receiptText = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as any;
    assert.equal(receipt.event_sequence, 7);
    assert.equal(receipt.evidence_index.observations.length, 1);
    assert.doesNotMatch(receiptText, /content_base64/);
    assert.doesNotMatch(receiptText, /semantic shadow source bytes/);
    assert.match(receiptText, /content_sha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
