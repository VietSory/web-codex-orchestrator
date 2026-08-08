import path from "node:path";
import crypto from "node:crypto";
import { ExecutorError, type ExecutorReceipt } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { ensureSecureExecutorSubdirectory, installImmutableDurableExecutorStateFile, readStableExecutorStateFile } from "./state-io.js";

const MAX_EVIDENCE_BYTES = 512 * 1024;

function evidenceDirectory(stateDirectory: string, receipt: ExecutorReceipt): string {
  return path.join(executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256).directory, "evidence");
}

export async function persistExecutorEvidence(options: { stateDirectory: string; receipt: ExecutorReceipt; name: string; bytes: Buffer; expectedSha256: string }): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.name) || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Evidence identity is invalid.");
  if (options.bytes.byteLength > MAX_EVIDENCE_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actual = crypto.createHash("sha256").update(options.bytes).digest("hex");
  if (actual !== options.expectedSha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Evidence bytes do not match expected SHA-256.");
  const paths = executorPaths(options.stateDirectory, options.receipt.task_id, options.receipt.task_bundle_sha256, options.receipt.artifact_sha256);
  await prepareExecutorDirectory(options.stateDirectory, paths.directory);
  const directory = evidenceDirectory(options.stateDirectory, options.receipt);
  await ensureSecureExecutorSubdirectory(paths.directory, directory);
  const finalPath = path.join(directory, `${options.name}-${actual}.json`);
  await installImmutableDurableExecutorStateFile(finalPath, options.bytes, MAX_EVIDENCE_BYTES);
  return path.relative(paths.directory, finalPath).split(path.sep).join("/");
}

async function assertOneEvidence(stateDirectory: string, receipt: ExecutorReceipt, name: string, digest: string | null): Promise<void> {
  if (digest === null) return;
  const filePath = path.join(evidenceDirectory(stateDirectory, receipt), `${name}-${digest}.json`);
  let bytes: Buffer;
  try { bytes = await readStableExecutorStateFile(filePath, MAX_EVIDENCE_BYTES); }
  catch (error) { throw new ExecutorError("EXECUTOR_STATE_INVALID", `Persisted executor gate evidence is unavailable for '${name}': ${error instanceof Error ? error.message : String(error)}`); }
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Persisted executor gate evidence hash changed for '${name}'.`);
}

export async function attestPersistedExecutorGateEvidence(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> {
  if (receipt.verification.evidence_sha256 !== null) await assertOneEvidence(stateDirectory, receipt, `verification-${receipt.verification.rounds}`, receipt.verification.evidence_sha256);
  if (receipt.terra_review.evidence_sha256 !== null) await assertOneEvidence(stateDirectory, receipt, `terra-${receipt.terra_review.rounds}`, receipt.terra_review.evidence_sha256);
  if (receipt.sol_review.evidence_sha256 !== null) await assertOneEvidence(stateDirectory, receipt, `sol-${receipt.sol_review.rounds}`, receipt.sol_review.evidence_sha256);
}
