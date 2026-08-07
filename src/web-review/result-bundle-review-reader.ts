// Phase 6 Result Bundle reader and verification wrapper for Phase 7
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebReviewError } from "./contracts.js";
import { assertExistingStatePathIsSafe, parseRunIdentity } from "./web-review-paths.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { verifyResultBundleZip } from "../result-bundle/zip-verifier.js";
import { loadEmbeddedReviewContracts, type LoadedEmbeddedContracts } from "./embedded-review-contracts.js";
import type { ResultBundleReceipt, ResultBundleManifest } from "../result-bundle/contracts.js";

export interface LoadedResultBundle {
  receipt: ResultBundleReceipt;
  phase6ReceiptSha256: string;
  archivePath: string;
  manifest: ResultBundleManifest;
  bundleEntries: Set<string>;
  reviewEntries: Map<string, Buffer>;
  acceptanceData: unknown;
  testMatrixData: unknown;
  validationData: unknown;
  riskPolicyData: unknown;
  embeddedContracts: LoadedEmbeddedContracts;
}

const MAX_PHASE6_RECEIPT_BYTES = 1024 * 1024;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function resultBundleInvalid(message: string, cause?: unknown): WebReviewError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : cause ? `: ${String(cause)}` : "";
  return new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `${message}${suffix}`);
}

async function assertSafeStateSource(stateDirectory: string, targetPath: string, label: string): Promise<void> {
  try {
    await assertExistingStatePathIsSafe(stateDirectory, targetPath, "file");
  } catch (error) {
    throw resultBundleInvalid(`${label} is outside the safe Phase 7 state path chain`, error);
  }
}

/**
 * Load and independently verify the exact Phase 6 Result Bundle.
 *
 * The run ID remains bound to the accepted Task Bundle archive SHA. The
 * Result Bundle archive has its own distinct SHA in the Phase 6 receipt.
 * Phase 7 must never conflate those two identities.
 */
export async function loadAndVerifyResultBundle(
  stateDirectory: string,
  runId: string
): Promise<LoadedResultBundle> {
  const { taskId, archiveSha256: taskBundleArchiveSha } = parseRunIdentity(runId);
  const p6Paths = resultBundlePaths(stateDirectory, taskId, taskBundleArchiveSha);

  await assertSafeStateSource(stateDirectory, p6Paths.receiptPath, "Phase 6 receipt");
  const receiptStat = await fs.stat(p6Paths.receiptPath);
  if (receiptStat.size > MAX_PHASE6_RECEIPT_BYTES) {
    throw resultBundleInvalid(`Phase 6 receipt exceeds ${MAX_PHASE6_RECEIPT_BYTES} bytes`);
  }

  let receiptRawBytes: Buffer;
  try {
    receiptRawBytes = await fs.readFile(p6Paths.receiptPath);
  } catch (error) {
    throw resultBundleInvalid(`Phase 6 receipt not found for run ID '${runId}'`, error);
  }
  if (receiptRawBytes.byteLength > MAX_PHASE6_RECEIPT_BYTES) {
    throw resultBundleInvalid(`Phase 6 receipt exceeds ${MAX_PHASE6_RECEIPT_BYTES} bytes during read`);
  }

  const phase6ReceiptSha256 = sha256Hex(receiptRawBytes);
  const receipt = await readResultBundleReceipt(p6Paths.receiptPath);
  if (!receipt) {
    throw resultBundleInvalid(`Phase 6 receipt not found for run ID '${runId}'`);
  }

  // The Phase 6 receipt is immutable at this boundary. Detect replacement or
  // mutation between the raw-byte binding read and the validated receipt read.
  await assertSafeStateSource(stateDirectory, p6Paths.receiptPath, "Phase 6 receipt");
  const receiptAfterBytes = await fs.readFile(p6Paths.receiptPath);
  if (receiptAfterBytes.byteLength > MAX_PHASE6_RECEIPT_BYTES || sha256Hex(receiptAfterBytes) !== phase6ReceiptSha256) {
    throw resultBundleInvalid("Phase 6 receipt changed while Phase 7 was loading it");
  }

  if (receipt.run_id !== runId) {
    throw resultBundleInvalid(`Phase 6 receipt run_id '${receipt.run_id}' does not match '${runId}'`);
  }
  if (receipt.state !== "READY_FOR_WEB_REVIEW") {
    throw resultBundleInvalid(`Phase 6 receipt state is '${receipt.state}', expected 'READY_FOR_WEB_REVIEW'`);
  }

  if (
    !receipt.archive_relative_path ||
    !receipt.archive_sha256 ||
    !receipt.manifest_sha256 ||
    !receipt.spec_set_sha256 ||
    !receipt.reviewed_entry_set_sha256 ||
    !receipt.published_commit_sha ||
    !receipt.pull_request ||
    !receipt.pull_request.head_sha ||
    receipt.archive_size_bytes === null ||
    receipt.entry_count === null ||
    receipt.uncompressed_size_bytes === null
  ) {
    throw resultBundleInvalid("Phase 6 receipt has null or incomplete binding fields.");
  }

  const absoluteStateDir = path.resolve(stateDirectory);
  const archivePath = path.resolve(absoluteStateDir, receipt.archive_relative_path);
  const expectedDir = path.resolve(p6Paths.directory);
  const archiveRelativeToRun = path.relative(expectedDir, archivePath);
  if (
    !archiveRelativeToRun ||
    archiveRelativeToRun === ".." ||
    archiveRelativeToRun.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativeToRun)
  ) {
    throw resultBundleInvalid(
      `Path traversal detected: archive_relative_path '${receipt.archive_relative_path}' escapes expected run directory '${expectedDir}'`
    );
  }

  await assertSafeStateSource(stateDirectory, archivePath, "Result Bundle archive");
  const lstat = await fs.lstat(archivePath);
  if (!lstat.isFile() || lstat.isSymbolicLink()) {
    throw resultBundleInvalid(`Result Bundle archive must be a regular non-symlink file: ${archivePath}`);
  }
  if (lstat.size !== receipt.archive_size_bytes) {
    throw resultBundleInvalid(
      `Archive file size (${lstat.size}) does not match receipt size (${receipt.archive_size_bytes})`
    );
  }

  let verificationResult: Awaited<ReturnType<typeof verifyResultBundleZip>>;
  try {
    verificationResult = await verifyResultBundleZip(archivePath);
  } catch (error) {
    throw resultBundleInvalid("Independent Result Bundle verification failed", error);
  }

  if (verificationResult.sha256 !== receipt.archive_sha256) {
    throw resultBundleInvalid(
      `Independent verifier archive sha256 '${verificationResult.sha256}' does not match receipt '${receipt.archive_sha256}'`
    );
  }
  if (verificationResult.reviewedEntrySetSha256 !== receipt.reviewed_entry_set_sha256) {
    throw resultBundleInvalid(
      `Independent verifier reviewed_entry_set_sha256 '${verificationResult.reviewedEntrySetSha256}' does not match receipt '${receipt.reviewed_entry_set_sha256}'`
    );
  }
  if (verificationResult.sizeBytes !== receipt.archive_size_bytes) {
    throw resultBundleInvalid(
      `Independent verifier archive size '${verificationResult.sizeBytes}' does not match receipt '${receipt.archive_size_bytes}'`
    );
  }
  if (verificationResult.entryCount !== receipt.entry_count) {
    throw resultBundleInvalid(
      `Independent verifier entry count '${verificationResult.entryCount}' does not match receipt '${receipt.entry_count}'`
    );
  }
  if (verificationResult.uncompressedBytes !== receipt.uncompressed_size_bytes) {
    throw resultBundleInvalid(
      `Independent verifier uncompressed size '${verificationResult.uncompressedBytes}' does not match receipt '${receipt.uncompressed_size_bytes}'`
    );
  }

  // Re-check the source path before reopening the archive for selective reads.
  await assertSafeStateSource(stateDirectory, archivePath, "Result Bundle archive");
  const archiveStatBeforeSelectiveRead = await fs.stat(archivePath);
  if (archiveStatBeforeSelectiveRead.size !== receipt.archive_size_bytes) {
    throw resultBundleInvalid("Result Bundle archive changed before selective review reads");
  }

  const embeddedContracts = await loadEmbeddedReviewContracts(archivePath, receipt);
  const manifest = embeddedContracts.manifest as ResultBundleManifest;
  const manifestBuf = embeddedContracts.entries.get("manifest.json");
  if (!manifestBuf) {
    throw resultBundleInvalid("Missing manifest.json in Result Bundle.");
  }
  const manifestSha = sha256Hex(manifestBuf);
  if (manifestSha !== receipt.manifest_sha256) {
    throw resultBundleInvalid(
      `Manifest SHA mismatch: got '${manifestSha}', expected '${receipt.manifest_sha256}'`
    );
  }

  if (!manifest || !Array.isArray(manifest.entries)) {
    throw resultBundleInvalid("Invalid manifest.json in Result Bundle.");
  }
  if (manifest.run_id !== runId) {
    throw resultBundleInvalid(`Manifest run_id '${manifest.run_id}' does not match '${runId}'`);
  }
  if (manifest.task_id !== taskId) {
    throw resultBundleInvalid(`Manifest task_id '${manifest.task_id}' does not match '${taskId}'`);
  }
  if (manifest.published_commit_sha !== receipt.published_commit_sha) {
    throw resultBundleInvalid("Manifest published_commit_sha does not match Phase 6 receipt.");
  }
  if (manifest.base_commit !== receipt.base_commit) {
    throw resultBundleInvalid("Manifest base_commit does not match Phase 6 receipt.");
  }
  if (manifest.change_set_sha256 !== receipt.change_set_sha256) {
    throw resultBundleInvalid("Manifest change_set_sha256 does not match Phase 6 receipt.");
  }
  if (manifest.pull_request_number !== receipt.pull_request.number) {
    throw resultBundleInvalid("Manifest pull_request_number does not match Phase 6 receipt.");
  }
  if (manifest.spec_set_sha256 !== receipt.spec_set_sha256) {
    throw resultBundleInvalid("Manifest spec_set_sha256 does not match Phase 6 receipt.");
  }
  if (manifest.reviewed_entry_set_sha256 !== receipt.reviewed_entry_set_sha256) {
    throw resultBundleInvalid("Manifest reviewed_entry_set_sha256 does not match Phase 6 receipt.");
  }

  const bundleEntries = new Set<string>(["manifest.json"]);
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      throw resultBundleInvalid("Manifest contains an invalid entry descriptor.");
    }
    if (bundleEntries.has(entry.path)) {
      throw resultBundleInvalid(`Manifest contains duplicate entry path '${entry.path}'.`);
    }
    bundleEntries.add(entry.path);
  }

  return {
    receipt,
    phase6ReceiptSha256,
    archivePath,
    manifest,
    bundleEntries,
    reviewEntries: embeddedContracts.entries,
    acceptanceData: embeddedContracts.acceptance,
    testMatrixData: embeddedContracts.testMatrix,
    validationData: embeddedContracts.validation,
    riskPolicyData: embeddedContracts.riskPolicy,
    embeddedContracts,
  };
}
