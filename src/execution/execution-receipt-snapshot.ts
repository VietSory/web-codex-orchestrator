import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readStableFile, StableFileError } from "../shared/stable-file.js";
import type { ExecutionReceipt } from "./contracts.js";
import { ExecutionError } from "./errors.js";
import { executionPaths, readExecutionReceipt } from "./execution-store.js";

const MAX_EXECUTION_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface ExecutionReceiptSnapshot {
  receipt: ExecutionReceipt;
  bytes: Buffer;
}

export async function readExecutionReceiptSnapshot(
  stateDirectory: string,
  taskId: string,
  archiveSha256: string,
): Promise<ExecutionReceiptSnapshot | undefined> {
  // Keep the existing execution-store validator as the single schema/state
  // authority. The stable snapshot below must decode to that exact canonical
  // object before its bytes can become a Result Bundle binding.
  const validated = await readExecutionReceipt(stateDirectory, taskId, archiveSha256);
  if (!validated) return undefined;

  const receiptPath = executionPaths(stateDirectory, taskId, archiveSha256).execution;
  let bytes: Buffer;
  try {
    bytes = (await readStableFile(receiptPath, MAX_EXECUTION_RECEIPT_BYTES)).bytes;
  } catch (error) {
    throw new ExecutionError(
      "EXECUTION_RECEIPT_INCONSISTENT",
      `Cannot bind execution receipt to stable bytes: ${error instanceof StableFileError ? error.message : error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Stable execution receipt bytes are not valid JSON.");
  }

  let stableCanonical: Buffer;
  try {
    stableCanonical = canonicalJsonBuffer(parsed);
  } catch (error) {
    throw new ExecutionError(
      "EXECUTION_RECEIPT_INCONSISTENT",
      `Stable execution receipt cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validatedCanonical = canonicalJsonBuffer(validated);
  if (!stableCanonical.equals(validatedCanonical)) {
    throw new ExecutionError(
      "EXECUTION_RECEIPT_INCONSISTENT",
      "Execution receipt changed between schema validation and stable byte binding.",
    );
  }

  return { receipt: validated, bytes };
}
