import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeTaskBundle } from "../src/web-bridge/task-contract-materializer.js";
import { prepareTask } from "../src/run/preparation-service.js";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";
import { materializeWebImplementationPack } from "../src/web-bridge/web-pack-materializer.js";
import { WEB_BRIDGE_PROTOCOL_VERSION } from "../src/web-bridge/contracts.js";

const run = promisify(execFile);
test("sealed Web contract and operations become accepted Task Bundle 1.3 and registered Web Pack v2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-v03-artifacts-")), repo = path.join(root, "repo"), remote = path.join(root, "remote.git"), state = path.join(root, "state"); await mkdir(repo); await run("git", ["init", "--bare", remote]); await run("git", ["init", "-b", "main"], { cwd: repo }); await run("git", ["config", "user.name", "Test"], { cwd: repo }); await run("git", ["config", "user.email", "test@example.invalid"], { cwd: repo }); await writeFile(path.join(repo, "app.txt"), "before\n"); await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } })); await run("git", ["add", "."], { cwd: repo }); await run("git", ["commit", "-m", "base"], { cwd: repo }); await run("git", ["remote", "add", "origin", remote], { cwd: repo }); const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const config: any = { config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 10 }, repositories: { repo: { path: repo, remote: "origin", expected_remote_urls: [remote], fetch_policy: "never" } }, runtime: { source: "bundled" }, verification: { allowed_executables: ["npm"], allowed_environment_keys: ["CI"], maximum_command_seconds: 60, maximum_output_bytes: 1000000, maximum_changed_files: 10, maximum_diff_lines: 1000, allowed_generated_paths: [] }, publish: { identity: { name: "Test", email: "test@example.invalid" }, authentication: { mode: "none" } } };
  const configPath = path.join(root, "config.json"); await writeFile(configPath, JSON.stringify(config));
  const envelope: any = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: "job-1", repository: { repository_id: "repo", base_branch: "main", base_commit: base }, user_intent: "change app", title: "Change app", goal: "Replace app content", non_goals: ["No unrelated changes"], architecture_decisions: ["Keep text format"], allowed_paths: ["app.txt"], forbidden_paths: [".git/**"], acceptance_criteria: [{ id: "AC-001", description: "app contains after" }], verification_commands: [{ id: "test", executable: "npm", args: ["test"] }], risk_policy: { network_access: false, secrets_required: false, notes: [] }, delivery: { remote: "origin", base_branch: "main", branch_name: "codex/change-app", draft: true, auto_merge: false }, sources: [{ url: "https://example.invalid/spec", title: "Spec", accessed_at: "2026-01-01T00:00:00.000Z", relevance: "Requirement" }], implementation_strategy: ["Replace exact file"], project_map_hints: ["app.txt"] };
  const task = await materializeTaskBundle({ envelope, repository: envelope.repository, config, stateDirectory: state }); assert.equal(task.intake_receipt.status, "accepted"); const repeated = await materializeTaskBundle({ envelope, repository: envelope.repository, config, stateDirectory: state }); assert.equal(repeated.archive_sha256, task.archive_sha256);
  const prepared = await prepareTask({ archivePath: task.archive_path, stateDirectory: state, configPath }); const coverage = new ReadCoverageStore(path.join(state, "bridge", "read-coverage")); const reader = new ExactRepositoryReadService(repo, envelope.repository, coverage); await reader.read(envelope.job_id, "read-app", ["app.txt"], () => new Date("2026-01-01T00:00:00.000Z")); const payload = Buffer.from("after\n");
  const submission: any = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: envelope.job_id, run_id: prepared.run_id, contract_only: false, summary: "replace app", operations: [{ kind: "replace", path: "app.txt", content_base64: payload.toString("base64"), content_sha256: (await import("node:crypto")).default.createHash("sha256").update(payload).digest("hex") }], project_map: [{ path: "app.txt", purpose: "fixture" }], sources: envelope.sources };
  const pack = await materializeWebImplementationPack({ submission, envelope, stateDirectory: state, configPath, coverageStore: coverage }); assert.equal(pack.registration.run_id, prepared.run_id); assert.equal(pack.registration.artifact_sha256, pack.archive_sha256);
});
