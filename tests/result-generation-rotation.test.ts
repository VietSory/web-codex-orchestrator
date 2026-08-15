import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { retireStaleResultGeneration } from "../src/orchestration/result-generation.js";
import { resultBundlePaths } from "../src/result-bundle/result-bundle-paths.js";

const sha = (value: Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const archive = "a".repeat(64);
const runId = `task:${archive}`;
const current = { executorReceiptSha256: "b".repeat(64), changeSetSha256: "c".repeat(64), baseCommit: "d".repeat(40) };

async function tempState(): Promise<string> { return await mkdtemp(path.join(os.tmpdir(), "wco-result-generation-")); }

function receipt(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    result_bundle_version: "1.1",
    run_id: runId,
    state: "READY_FOR_WEB_REVIEW",
    execution_receipt_sha256: current.executorReceiptSha256,
    change_set_sha256: current.changeSetSha256,
    base_commit: current.baseCommit,
    ...overrides,
  }));
}

test("missing Result receipt is a no-op", async () => {
  const state = await tempState();
  try {
    assert.equal(await retireStaleResultGeneration({ stateDirectory: state, runId, ...current }), false);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("exact current Result generation is preserved", async () => {
  const state = await tempState();
  try {
    const paths = resultBundlePaths(state, "task", archive);
    await mkdir(paths.directory, { recursive: true });
    const bytes = receipt();
    await writeFile(paths.receiptPath, bytes);
    assert.equal(await retireStaleResultGeneration({ stateDirectory: state, runId, ...current }), false);
    assert.deepEqual(await readFile(paths.receiptPath), bytes);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("stale READY Result receipt is archived byte-exact before canonical retirement", async () => {
  const state = await tempState();
  try {
    const paths = resultBundlePaths(state, "task", archive);
    await mkdir(paths.directory, { recursive: true });
    const bytes = receipt({ execution_receipt_sha256: "e".repeat(64), change_set_sha256: "f".repeat(64) });
    await writeFile(paths.receiptPath, bytes);
    assert.equal(await retireStaleResultGeneration({ stateDirectory: state, runId, ...current }), true);
    await assert.rejects(stat(paths.receiptPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const history = path.join(paths.directory, "history");
    assert.deepEqual(await readdir(history), [`result-receipt-${sha(bytes)}.json`]);
    assert.deepEqual(await readFile(path.join(history, `result-receipt-${sha(bytes)}.json`)), bytes);
  } finally { await rm(state, { recursive: true, force: true }); }
});
