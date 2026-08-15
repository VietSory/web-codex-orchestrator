import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

class OrderedBridge extends FakeWebBridge {
  readonly order: string[] = [];

  override async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult): Promise<void> {
    this.order.push("web-submit");
    await super.submitRepositoryCommandResult(jobId, result);
  }
}

const config = {} as any;

async function exerciseInjectedObserver(options: { fail: boolean }): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-runtime-shadow-"));
  try {
    const { repo, base } = await repository(root);
    const stateDirectory = path.join(root, "state");
    const bridge = new OrderedBridge();
    const current = session(base);
    bridge.enqueue(current.job_id!, {
      sequence: 1,
      type: "repository_command",
      request_id: "tree-1",
      command: { operation: "tree", maximum_paths: 8 },
    });

    let observed: any = null;
    const advanced = await advanceLocalWorker({
      bridge,
      session: current,
      repositoryPath: repo,
      stateDirectory,
      configPath: path.join(root, "unused-config.json"),
      config,
      maximumEvents: 1,
      semanticShadowObserver: async (input) => {
        bridge.order.push("shadow-observe");
        observed = input;
        if (options.fail) throw new Error("intentional shadow failure");
        return { receipt: {} as any, path: "unused", status: "created" };
      },
    });

    assert.deepEqual(bridge.order, ["web-submit", "shadow-observe"]);
    assert.equal(bridge.repositoryResults.length, 1);
    assert.equal(bridge.repositoryResults[0]?.request_id, "tree-1");
    assert.equal(observed?.eventSequence, 1);
    assert.equal(observed?.requestId, "tree-1");
    assert.deepEqual(observed?.command, { operation: "tree", maximum_paths: 8 });
    assert.deepEqual(observed?.result, bridge.repositoryResults[0]?.result);
    assert.equal(advanced.last_event_sequence, 1);

    const persisted = await readLocalWorkerSession(stateDirectory, "repo");
    assert.equal(persisted?.last_event_sequence, 1);
    assert.equal(persisted?.state, "AUTHORING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runtime shadow observes the exact repository result only after Web receives it", async () => {
  await exerciseInjectedObserver({ fail: false });
});

test("runtime shadow failure cannot block Web context delivery or authoring checkpoint progress", async () => {
  await exerciseInjectedObserver({ fail: true });
});

test("default runtime shadow persists digest-bound read evidence without source bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-runtime-shadow-real-"));
  try {
    const { repo, base } = await repository(root);
    const stateDirectory = path.join(root, "state");
    const bridge = new OrderedBridge();
    const current = session(base);
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

    assert.equal(advanced.last_event_sequence, 1);
    assert.equal(bridge.repositoryResults.length, 1);
    const relayPayload = JSON.stringify(bridge.repositoryResults[0]);
    assert.match(relayPayload, /content_base64/);

    const receiptPath = semanticShadowReceiptPath({
      stateDirectory,
      repositoryId: "repo",
      sessionId: current.session_id,
      eventSequence: 1,
      requestId: "read-1",
    });
    const receiptText = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as any;
    assert.equal(receipt.event_sequence, 1);
    assert.equal(receipt.evidence_index.observations.length, 1);
    assert.doesNotMatch(receiptText, /content_base64/);
    assert.doesNotMatch(receiptText, /semantic shadow source bytes/);
    assert.match(receiptText, /content_sha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
