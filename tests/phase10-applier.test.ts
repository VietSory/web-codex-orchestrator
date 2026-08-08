import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { WebImplementationPack, WebImplementationOperation } from "../src/web-authority/contracts.js";
import { applyExecutorTransaction, prepareExecutorTransaction } from "../src/executor/applier.js";
import { ExecutorError } from "../src/executor/contracts.js";

const sha = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");

function pack(operations: WebImplementationOperation[], payloads: Record<string, Buffer>): WebImplementationPack {
  const entries = new Map<string, Buffer>(Object.entries(payloads));
  return {
    archive_sha256: "b".repeat(64),
    archive_size_bytes: 1,
    entry_count: entries.size,
    uncompressed_size_bytes: [...entries.values()].reduce((total, value) => total + value.byteLength, 0),
    manifest: {
      schema_version: "2.0",
      kind: "wco-web-implementation-pack",
      pack_id: "PACK-P10",
      run_id: `TASK-P10:${"a".repeat(64)}`,
      task_id: "TASK-P10",
      task_bundle_sha256: "a".repeat(64),
      repository: { id: "fixture", base_branch: "main", base_commit: "1".repeat(40), tree_sha: "2".repeat(40) },
      bindings: {
        spec_set_sha256: "3".repeat(64), repository_inventory_sha256: "4".repeat(64), read_coverage_sha256: "5".repeat(64), project_map_sha256: "6".repeat(64), source_receipts_sha256: "7".repeat(64), preimages_sha256: "8".repeat(64), architecture_lock_sha256: "9".repeat(64), acceptance_lock_sha256: "a".repeat(64), prohibited_changes_sha256: "b".repeat(64), operations_sha256: "c".repeat(64),
      },
      created_at: "2026-08-08T00:00:00.000Z",
    },
    operations: { schema_version: "2.0", operations },
    preimages: { schema_version: "2.0", entries: operations.map((operation) => ({ path: operation.path, sha256: operation.preimage_sha256 })) },
    sources: { schema_version: "2.0", receipts: [] },
    entries,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p10-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, "replace.txt"), "old replace\n");
  await fs.writeFile(path.join(worktree, "delete.txt"), "old delete\n");
  const replacePayload = Buffer.from("new replace\n");
  const createPayload = Buffer.from("new create\n");
  const operations: WebImplementationOperation[] = [
    { op_id: "OP-REPLACE", kind: "replace_file", path: "replace.txt", preimage_sha256: sha("old replace\n"), payload_entry: "payload/replace.bin", payload_sha256: sha(replacePayload) },
    { op_id: "OP-DELETE", kind: "delete_file", path: "delete.txt", preimage_sha256: sha("old delete\n") },
    { op_id: "OP-CREATE", kind: "create_file", path: "create.txt", preimage_sha256: null, payload_entry: "payload/create.bin", payload_sha256: sha(createPayload) },
  ];
  return { root, state, worktree, operations, pack: pack(operations, { "payload/replace.bin": replacePayload, "payload/create.bin": createPayload }) };
}

function prepareOptions(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    stateDirectory: f.state,
    runId: `TASK-P10:${"a".repeat(64)}`,
    taskId: "TASK-P10",
    taskBundleSha256: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    pack: f.pack,
    repositoryId: "fixture",
    baseBranch: "main",
    baseCommit: "1".repeat(40),
    baseTreeSha: "2".repeat(40),
    worktreePath: f.worktree,
    registrationManifestSha256: "d".repeat(64),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  };
}

test("P10-APPLY-001 all preimages are proven before first write, then exact replace/delete/create apply", async (t) => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const receipt = await prepareExecutorTransaction(prepareOptions(f));
  assert.equal(receipt.state, "PREPARED");
  assert.equal(await fs.readFile(path.join(f.worktree, "replace.txt"), "utf8"), "old replace\n");
  assert.equal(await fs.readFile(path.join(f.worktree, "delete.txt"), "utf8"), "old delete\n");
  await assert.rejects(() => fs.readFile(path.join(f.worktree, "create.txt")));
  const applied = await applyExecutorTransaction({ stateDirectory: f.state, receipt, pack: f.pack });
  assert.equal(applied.state, "APPLIED");
  assert.equal(await fs.readFile(path.join(f.worktree, "replace.txt"), "utf8"), "new replace\n");
  await assert.rejects(() => fs.readFile(path.join(f.worktree, "delete.txt")));
  assert.equal(await fs.readFile(path.join(f.worktree, "create.txt"), "utf8"), "new create\n");
});

test("P10-APPLY-002 stale later preimage prevents every write", async (t) => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(f.worktree, "delete.txt"), "external drift\n");
  await assert.rejects(() => prepareExecutorTransaction(prepareOptions(f)), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_PREIMAGE_STALE");
  assert.equal(await fs.readFile(path.join(f.worktree, "replace.txt"), "utf8"), "old replace\n");
  await assert.rejects(() => fs.readFile(path.join(f.worktree, "create.txt")));
});

test("P10-APPLY-003 crash recovery adopts registered postimage and continues remaining operations", async (t) => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const receipt = await prepareExecutorTransaction(prepareOptions(f));
  await fs.writeFile(path.join(f.worktree, "replace.txt"), "new replace\n");
  receipt.state = "APPLYING";
  const applied = await applyExecutorTransaction({ stateDirectory: f.state, receipt, pack: f.pack });
  assert.equal(applied.state, "APPLIED");
  assert.ok(applied.operations.every((operation) => operation.applied));
  assert.equal(await fs.readFile(path.join(f.worktree, "create.txt"), "utf8"), "new create\n");
});

test("P10-APPLY-004 ambiguous recovery bytes escalate instead of guessing", async (t) => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const receipt = await prepareExecutorTransaction(prepareOptions(f));
  await fs.writeFile(path.join(f.worktree, "replace.txt"), "neither pre nor post\n");
  receipt.state = "APPLYING";
  await assert.rejects(() => applyExecutorTransaction({ stateDirectory: f.state, receipt, pack: f.pack }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_AMBIGUOUS_RECOVERY");
});
