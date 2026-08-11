import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { readStableFile } from "../shared/stable-file.js";
import { OrchestrationError } from "./contracts.js";

const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

/**
 * A repaired/re-published executor needs a new Result Bundle. Phase 6 normally
 * returns an existing READY receipt, so retire only a READY receipt proven stale
 * against the new exact executor generation. Its archive ZIP is commit-named and
 * remains untouched; the receipt bytes are preserved under history before the
 * canonical pointer is removed for deterministic rebuild.
 */
export async function retireStaleResultGeneration(options: {
  stateDirectory: string;
  runId: string;
  executorReceiptSha256: string;
  changeSetSha256: string;
  baseCommit: string;
}): Promise<boolean> {
  const split = options.runId.lastIndexOf(":");
  const taskId = options.runId.slice(0, split), archiveSha = options.runId.slice(split + 1);
  if (split < 1 || !/^[a-f0-9]{64}$/.test(archiveSha)) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Invalid run identity while rotating Result Bundle generation.");
  const paths = resultBundlePaths(path.resolve(options.stateDirectory), taskId, archiveSha);
  let first: Buffer;
  try { first = (await readStableFile(paths.receiptPath, MAX_RECEIPT_BYTES)).bytes; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(first.toString("utf8")) as Record<string, unknown>; }
  catch { throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Existing Result Bundle receipt is not valid JSON."); }
  if (parsed.run_id !== options.runId || parsed.state !== "READY_FOR_WEB_REVIEW") return false;
  if (parsed.execution_receipt_sha256 === options.executorReceiptSha256 && parsed.change_set_sha256 === options.changeSetSha256 && parsed.base_commit === options.baseCommit) return false;

  const history = path.join(paths.directory, "history");
  await fs.mkdir(history, { recursive: true, mode: 0o700 });
  const historyInfo = await fs.lstat(history);
  if (!historyInfo.isDirectory() || historyInfo.isSymbolicLink() || await fs.realpath(history) !== history) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Result generation history directory is unsafe.");
  const target = path.join(history, `result-receipt-${sha256(first)}.json`);
  try { await fs.writeFile(target, first, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const archived = (await readStableFile(target, MAX_RECEIPT_BYTES)).bytes;
    if (!archived.equals(first)) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Archived Result Bundle generation conflicts with the exact stale receipt bytes.");
  }

  const second = (await readStableFile(paths.receiptPath, MAX_RECEIPT_BYTES)).bytes;
  if (!second.equals(first)) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Result Bundle receipt changed while a stale generation was being retired.");
  await fs.unlink(paths.receiptPath);
  return true;
}
