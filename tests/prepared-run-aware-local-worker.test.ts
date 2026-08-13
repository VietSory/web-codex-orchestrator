import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advanceLocalWorker, readLocalWorkerSession, startLocalAuthoring } from "../src/web-bridge/local-worker.js";
import { FakeWebBridge } from "../src/web-bridge/fake-web-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION } from "../src/web-bridge/contracts.js";

const run = promisify(execFile);

async function repository(root: string): Promise<{ repo: string; base: string; remote: string }> {
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await run("git", ["init", "--bare", remote]);
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["config", "user.name", "Test"], { cwd: repo });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "before\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  await run("git", ["remote", "add", "origin", remote], { cwd: repo });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return { repo, base, remote };
}

function trustedConfig(repo: string, remote: string): any {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { repo: { path: repo, remote: "origin", expected_remote_urls: [remote], fetch_policy: "never" } },
    runtime: { source: "bundled" },
    verification: {
      allowed_executables: ["npm"],
      allowed_environment_keys: ["CI"],
      maximum_command_seconds: 60,
      maximum_output_bytes: 1_000_000,
      maximum_changed_files: 10,
      maximum_diff_lines: 1_000,
      allowed_generated_paths: [],
    },
    publish: { identity: { name: "Test", email: "test@example.invalid" }, authentication: { mode: "none" } },
  };
}

function contract(jobId: string, base: string): any {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    repository: { repository_id: "repo", base_branch: "main", base_commit: base },
    user_intent: "change app",
    title: "Change app",
    goal: "Replace app",
    non_goals: ["No unrelated change"],
    architecture_decisions: ["Keep format"],
    allowed_paths: ["app.txt"],
    forbidden_paths: [".git/**"],
    acceptance_criteria: [{ id: "AC-001", description: "app changed" }],
    verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
    risk_policy: { network_access: false, secrets_required: false, notes: [] },
    delivery: { remote: "origin", base_branch: "main", branch_name: "codex/prepared-binding", draft: true, auto_merge: false },
    sources: [],
    implementation_strategy: ["replace app"],
    project_map_hints: ["app.txt"],
  };
}

class PreparedAwareBridge extends FakeWebBridge {
  readonly bindings: Array<{ jobId: string; runId: string; idempotencyKey: string }> = [];
  constructor(private readonly failBinding = false) { super(); }

  async bindPreparedRun(jobId: string, runId: string, idempotencyKey: string): Promise<void> {
    this.bindings.push({ jobId, runId, idempotencyKey });
    if (this.failBinding) throw new Error("prepared binding rejected");
  }
}

test("prepared-run-aware bridge receives canonical run binding before PREPARED is committed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-prepared-bind-"));
  const { repo, base, remote } = await repository(root);
  const stateDirectory = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const config = trustedConfig(repo, remote);
  await writeFile(configPath, JSON.stringify(config));
  const bridge = new PreparedAwareBridge();

  try {
    const session = await startLocalAuthoring({
      bridge,
      repository: { repository_id: "repo", base_branch: "main", base_commit: base },
      goal: "change app",
      stateDirectory,
      mode: "AUTOPILOT",
    });
    bridge.enqueue(session.job_id!, { sequence: 1, type: "contract_sealed", envelope: contract(session.job_id!, base) });

    const prepared = await advanceLocalWorker({ bridge, session, repositoryPath: repo, stateDirectory, configPath, config, stopAfterPrepared: true });

    assert.equal(prepared.state, "PREPARED");
    assert.ok(prepared.run_id);
    assert.equal(bridge.bindings.length, 1);
    assert.equal(bridge.bindings[0]?.jobId, prepared.job_id);
    assert.equal(bridge.bindings[0]?.runId, prepared.run_id);
    assert.match(bridge.bindings[0]?.idempotencyKey ?? "", /^bind-prepared-[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared-run binding failure is fail-closed and does not persist PREPARED state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-prepared-bind-fail-"));
  const { repo, base, remote } = await repository(root);
  const stateDirectory = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  const config = trustedConfig(repo, remote);
  await writeFile(configPath, JSON.stringify(config));
  const bridge = new PreparedAwareBridge(true);

  try {
    const session = await startLocalAuthoring({
      bridge,
      repository: { repository_id: "repo", base_branch: "main", base_commit: base },
      goal: "change app",
      stateDirectory,
      mode: "AUTOPILOT",
    });
    bridge.enqueue(session.job_id!, { sequence: 1, type: "contract_sealed", envelope: contract(session.job_id!, base) });

    await assert.rejects(
      () => advanceLocalWorker({ bridge, session, repositoryPath: repo, stateDirectory, configPath, config, stopAfterPrepared: true }),
      /prepared binding rejected/,
    );

    const persisted = await readLocalWorkerSession(stateDirectory, "repo");
    assert.equal(persisted?.state, "AUTHORING");
    assert.equal(persisted?.sealed, false);
    assert.equal(persisted?.run_id, null);
    assert.equal(persisted?.last_event_sequence, 0);
    assert.equal(bridge.bindings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
