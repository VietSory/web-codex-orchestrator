import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalJsonBuffer } from "../../src/result-bundle/canonical-json.js";
import type { ExecutorReceipt } from "../../src/executor/contracts.js";
import { executorPaths, prepareExecutorDirectory } from "../../src/executor/paths.js";

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/executor/standalone-cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

function receipt(worktree: string): ExecutorReceipt {
  return {
    executor_version: "1.0", run_id: `TASK-CLI-P10:${"a".repeat(64)}`, task_id: "TASK-CLI-P10", task_bundle_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), pack_id: "PACK-CLI-P10", state: "ESCALATE_TO_WEB",
    repository_id: "fixture", base_branch: "main", base_commit: "1".repeat(40), base_tree_sha: "2".repeat(40), worktree_path: worktree, registration_manifest_sha256: "d".repeat(64), operations: [], change_set_digest: null,
    verification: { rounds: 0, passed: false, change_set_digest: null, evidence_sha256: null }, terra_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null }, sol_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null }, errors: [], created_at: "2026-08-08T00:00:00.000Z", updated_at: "2026-08-08T00:00:00.000Z",
  };
}

test("CLI-P10-001 compiled executor status reads bounded persisted state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-p10-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"); const item = receipt(path.join(root, "worktree")); const paths = executorPaths(state, item.task_id, item.task_bundle_sha256, item.artifact_sha256);
  await prepareExecutorDirectory(state, paths.directory); await fs.writeFile(paths.receipt, canonicalJsonBuffer(item), { mode: 0o600 });
  const result = await run(["status", "--run-id", item.run_id, "--artifact-sha256", item.artifact_sha256, "--state-dir", state, "--json"]);
  assert.equal(result.code, 0, result.stderr); const parsed = JSON.parse(result.stdout) as ExecutorReceipt; assert.equal(parsed.state, "ESCALATE_TO_WEB"); assert.equal(parsed.artifact_sha256, item.artifact_sha256);
});

test("CLI-P10-002 execute rejects missing registration before Codex runtime preflight", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-p10-missing-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-CLI-P10-MISSING:${"a".repeat(64)}`;
  const result = await run(["execute", "--run-id", runId, "--artifact-sha256", "b".repeat(64), "--state-dir", path.join(root, "state"), "--config", path.join(root, "missing-config.json"), "--json"]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EXECUTOR_REGISTRATION_NOT_FOUND/); assert.doesNotMatch(result.stderr, /CODEX_/);
});
