import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { WebImplementationPack, WebImplementationOperation } from "../src/web-authority/contracts.js";
import { prepareExecutorTransaction } from "../src/executor/applier.js";
import { attestExecutorResumeChangedPaths } from "../src/executor/change-set.js";
import { ExecutorError, type ExecutorReceipt } from "../src/executor/contracts.js";
import { persistExecutorEvidence } from "../src/executor/evidence-store.js";
import { executorPaths, prepareExecutorDirectory } from "../src/executor/paths.js";
import { readExecutorReceipt } from "../src/executor/store.js";

const sha = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(Buffer.concat(err).toString("utf8"))));
  });
}

function baseReceipt(worktree: string, baseCommit = "1".repeat(40)): ExecutorReceipt {
  return {
    executor_version: "1.0", run_id: `TASK-P10-M:${"a".repeat(64)}`, task_id: "TASK-P10-M", task_bundle_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), pack_id: "PACK-P10-M", state: "APPLYING",
    repository_id: "fixture", base_branch: "main", base_commit: baseCommit, base_tree_sha: "2".repeat(40), worktree_path: worktree, registration_manifest_sha256: "d".repeat(64),
    operations: [{ op_id: "OP-ONE", kind: "create_file", path: "allowed.txt", preimage_sha256: null, postimage_sha256: sha("allowed\n"), backup_relative_path: null, backup_sha256: null, original_mode: null, applied: true }],
    change_set_digest: null, verification: { rounds: 0, passed: false, change_set_digest: null, evidence_sha256: null }, terra_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null }, sol_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null }, errors: [], created_at: "2026-08-08T00:00:00.000Z", updated_at: "2026-08-08T00:00:00.000Z",
  };
}

function replacePack(): { pack: WebImplementationPack; operation: WebImplementationOperation; payload: Buffer } {
  const payload = Buffer.from("new\n");
  const operation: WebImplementationOperation = { op_id: "OP-REPLACE", kind: "replace_file", path: "file.txt", preimage_sha256: sha("old\n"), payload_entry: "payload/file.bin", payload_sha256: sha(payload) };
  const entries = new Map<string, Buffer>([["payload/file.bin", payload]]);
  return { operation, payload, pack: {
    archive_sha256: "b".repeat(64), archive_size_bytes: 1, entry_count: 1, uncompressed_size_bytes: payload.byteLength,
    manifest: { schema_version: "2.0", kind: "wco-web-implementation-pack", pack_id: "PACK-P10-M", run_id: `TASK-P10-M:${"a".repeat(64)}`, task_id: "TASK-P10-M", task_bundle_sha256: "a".repeat(64), repository: { id: "fixture", base_branch: "main", base_commit: "1".repeat(40), tree_sha: "2".repeat(40) }, bindings: { spec_set_sha256: "3".repeat(64), repository_inventory_sha256: "4".repeat(64), read_coverage_sha256: "5".repeat(64), project_map_sha256: "6".repeat(64), source_receipts_sha256: "7".repeat(64), preimages_sha256: "8".repeat(64), architecture_lock_sha256: "9".repeat(64), acceptance_lock_sha256: "a".repeat(64), prohibited_changes_sha256: "b".repeat(64), operations_sha256: "c".repeat(64) }, created_at: "2026-08-08T00:00:00.000Z" },
    operations: { schema_version: "2.0", operations: [operation] }, preimages: { schema_version: "2.0", entries: [{ path: operation.path, sha256: operation.preimage_sha256 }] }, sources: { schema_version: "2.0", receipts: [] }, entries,
  } };
}

test("P10-MAINT-001 crash resume rejects unregistered worktree changes before continuing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p10-resume-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]); await git(root, ["config", "user.email", "test@example.com"]); await git(root, ["config", "user.name", "WCO Test"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-qm", "base"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await fs.writeFile(path.join(root, "allowed.txt"), "allowed\n"); await fs.writeFile(path.join(root, "rogue.txt"), "rogue\n");
  await assert.rejects(() => attestExecutorResumeChangedPaths(baseReceipt(root, head)), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_UNREGISTERED_CHANGE" && error.message.includes("rogue.txt"));
});

test("P10-MAINT-002 executor receipt symlink replacement fails closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p10-receipt-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"); const receipt = baseReceipt(path.join(root, "worktree")); const paths = executorPaths(state, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256);
  await prepareExecutorDirectory(state, paths.directory);
  const outside = path.join(root, "outside.json"); await fs.writeFile(outside, JSON.stringify(receipt)); await fs.symlink(outside, paths.receipt);
  await assert.rejects(() => readExecutorReceipt(state, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID");
});

test("P10-MAINT-003 symlinked backup directory cannot redirect preimage backups", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p10-backup-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"); const worktree = path.join(root, "worktree"); await fs.mkdir(worktree); await fs.writeFile(path.join(worktree, "file.txt"), "old\n");
  const { pack } = replacePack(); const paths = executorPaths(state, "TASK-P10-M", "a".repeat(64), "b".repeat(64)); await prepareExecutorDirectory(state, paths.directory);
  const outside = path.join(root, "outside-backups"); await fs.mkdir(outside); await fs.symlink(outside, paths.backups, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => prepareExecutorTransaction({ stateDirectory: state, runId: `TASK-P10-M:${"a".repeat(64)}`, taskId: "TASK-P10-M", taskBundleSha256: "a".repeat(64), artifactSha256: "b".repeat(64), pack, repositoryId: "fixture", baseBranch: "main", baseCommit: "1".repeat(40), baseTreeSha: "2".repeat(40), worktreePath: worktree, registrationManifestSha256: "d".repeat(64) }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
});

test("P10-MAINT-004 symlinked evidence directory cannot redirect reviewer evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p10-evidence-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"); const receipt = baseReceipt(path.join(root, "worktree")); const paths = executorPaths(state, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256); await prepareExecutorDirectory(state, paths.directory);
  const outside = path.join(root, "outside-evidence"); await fs.mkdir(outside); await fs.symlink(outside, path.join(paths.directory, "evidence"), process.platform === "win32" ? "junction" : "dir");
  const bytes = Buffer.from("{}\n"); const digest = sha(bytes);
  await assert.rejects(() => persistExecutorEvidence({ stateDirectory: state, receipt, name: "test", bytes, expectedSha256: digest }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
});
