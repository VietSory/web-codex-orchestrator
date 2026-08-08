import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ExecutorError, type ExecutorReceipt } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { ensureSecureExecutorSubdirectory, readStableExecutorStateFile } from "./state-io.js";

const MAX_EVIDENCE_BYTES = 512 * 1024;

export async function persistExecutorEvidence(options: { stateDirectory: string; receipt: ExecutorReceipt; name: string; bytes: Buffer; expectedSha256: string }): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.name) || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Evidence identity is invalid.");
  if (options.bytes.byteLength > MAX_EVIDENCE_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actual = crypto.createHash("sha256").update(options.bytes).digest("hex");
  if (actual !== options.expectedSha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Evidence bytes do not match expected SHA-256.");
  const paths = executorPaths(options.stateDirectory, options.receipt.task_id, options.receipt.task_bundle_sha256, options.receipt.artifact_sha256);
  await prepareExecutorDirectory(options.stateDirectory, paths.directory);
  const evidenceDirectory = path.join(paths.directory, "evidence");
  await ensureSecureExecutorSubdirectory(paths.directory, evidenceDirectory);
  const finalPath = path.join(evidenceDirectory, `${options.name}-${actual}.json`);
  try { await fs.writeFile(finalPath, options.bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readStableExecutorStateFile(finalPath, MAX_EVIDENCE_BYTES);
    if (existing.byteLength !== options.bytes.byteLength || crypto.createHash("sha256").update(existing).digest("hex") !== actual) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Immutable executor evidence path contains different bytes.");
  }
  return path.relative(paths.directory, finalPath).split(path.sep).join("/");
}
