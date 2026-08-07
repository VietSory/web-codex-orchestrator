// Exact Result Bundle reader and verification wrapper for Phase 7/8 review rounds
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebReviewError } from "./contracts.js";
import { assertExistingStatePathIsSafe, parseRunIdentity } from "./web-review-paths.js";
import { assertResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { verifyResultBundleZip } from "../result-bundle/zip-verifier.js";
import { loadEmbeddedReviewContracts, type LoadedEmbeddedContracts } from "./embedded-review-contracts.js";
import type { ResultBundleReceipt, ResultBundleManifest } from "../result-bundle/contracts.js";

export interface LoadedResultBundle {
  receipt: ResultBundleReceipt;
  /**
   * Backward-compatible field name from Phase 7. For revision reviews this is
   * the SHA-256 of the selected Phase 8 revision Result Bundle receipt.
   */
  phase6ReceiptSha256: string;
  reviewRound: number;
  receiptPath: string;
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

const MAX_RESULT_RECEIPT_BYTES = 1024 * 1024;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function resultBundleInvalid(message: string, cause?: unknown): WebReviewError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : cause ? `: ${String(cause)}` : "";
  return new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `${message}${suffix}`);
}

function selectedResultPaths(
  stateDirectory: string,
  taskId: string,
  taskBundleArchiveSha: string,
  reviewRound: number
): { directory: string; receiptPath: string; label: string } {
  if (!Number.isInteger(reviewRound) || reviewRound < 1 || reviewRound > 4) {
    throw resultBundleInvalid(`Web review round must be an integer between 1 and 4; got ${reviewRound}`);
  }
  if (reviewRound === 1) {
    const initial = resultBundlePaths(stateDirectory, taskId, taskBundleArchiveSha);
    return { directory: initial.directory, receiptPath: initial.receiptPath, label: "initial Phase 6 Result Bundle receipt" };
  }
  const revisionRound = reviewRound - 1;
  const padded = String(revisionRound).padStart(2, "0");
  const directory = path.join(
    path.resolve(stateDirectory),
    "handoff",
    "runs",
    taskId,
    taskBundleArchiveSha,
    "revisions",
    padded
  );
  return {
    directory,
    receiptPath: path.join(directory, "result-bundle.json"),
    label: `Phase 8 revision ${revisionRound} Result Bundle receipt`,
  };
}

async function assertSafeStateSource(stateDirectory: string, targetPath: string, label: string): Promise<void> {
  try {
    await assertExistingStatePathIsSafe(stateDirectory, targetPath, "file");
  } catch (error) {
    throw resultBundleInvalid(`${label} is outside the safe review state path chain`, error);
  }
}

async function readBoundedStableReceipt(receiptPath: string, label: string): Promise<Buffer> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(receiptPath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_RESULT_RECEIPT_BYTES) {
      throw resultBundleInvalid(`${label} exceeds ${MAX_RESULT_RECEIPT_BYTES} bytes or is not a regular file`);
    }

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, offset, opened.size - offset, offset);
      if (bytesRead === 0) throw resultBundleInvalid(`${label} was truncated during read`);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, opened.size);
    if (extraBytes !== 0) throw resultBundleInvalid(`${label} grew during read`);

    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw resultBundleInvalid(`${label} changed while the reviewer was loading it`);
    }
    return buffer;
  } catch (error) {
    if (error instanceof WebReviewError) throw error;
    throw resultBundleInvalid(`Cannot read ${label}`, error);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Load and independently verify the exact Result Bundle for one Web review
 * round. Round 1 selects the immutable initial Phase 6 bundle; rounds 2..4
 * select Phase 8 revision bundles 1..3. There is no fallback to an older
 * bundle when the required revision bundle is missing.
 */
export async function loadAndVerifyResultBundle(
  stateDirectory: string,
  runId: string,
  reviewRound = 1
): Promise<LoadedResultBundle> {
  const { taskId, archiveSha256: taskBundleArchiveSha } = parseRunIdentity(runId);
  const selected = selectedResultPaths(stateDirectory, taskId, taskBundleArchiveSha, reviewRound);

  try {
    await fs.lstat(selected.receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw resultBundleInvalid(`${selected.label} not found for run ID '${runId}' and Web review round ${reviewRound}`);
    }
    throw resultBundleInvalid(`Cannot inspect ${selected.label} for run ID '${runId}'`, error);
  }

  await assertSafeStateSource(stateDirectory, selected.receiptPath, selected.label);
  const receiptRawBytes = await readBoundedStableReceipt(selected.receiptPath, selected.label);
  const selectedReceiptSha256 = sha256Hex(receiptRawBytes);

  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(receiptRawBytes.toString("utf8"));
    assertResultBundleReceipt(receiptValue);
  } catch (error) {
    throw resultBundleInvalid(`${selected.label} is malformed or invalid`, error);
  }
  const receipt = receiptValue as ResultBundleReceipt;

  // Revalidate the path after the fd-bound read so replacement through a later
  // symlink or moved ancestor cannot silently become the authority source.
  await assertSafeStateSource(stateDirectory, selected.receiptPath, selected.label);

  if (receipt.run_id !== runId) {
    throw resultBundleInvalid(`Selected Result Bundle receipt run_id '${receipt.run_id}' does not match '${runId}'`);
  }
  if (receipt.state !== "READY_FOR_WEB_REVIEW") {
    throw resultBundleInvalid(`Selected Result Bundle receipt state is '${receipt.state}', expected 'READY_FOR_WEB_REVIEW'`);
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
    throw resultBundleInvalid("Selected Result Bundle receipt has null or incomplete binding fields.");
  }

  const absoluteStateDir = path.resolve(stateDirectory);
  const archivePath = path.resolve(absoluteStateDir, receipt.archive_relative_path);
  const expectedDir = path.resolve(selected.directory);
  const archiveRelativeToRun = path.relative(expectedDir, archivePath);
  if (
    !archiveRelativeToRun ||
    archiveRelativeToRun === ".." ||
    archiveRelativeToRun.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativeToRun)
  ) {
    throw resultBundleInvalid(
      `Path traversal detected: archive_relative_path '${receipt.archive_relative_path}' escapes expected Result Bundle directory '${expectedDir}'`
    );
  }

  await assertSafeStateSource(stateDirectory, archivePath, "Result Bundle archive");
  const archiveLstat = await fs.lstat(archivePath);
  if (!archiveLstat.isFile() || archiveLstat.isSymbolicLink()) {
    throw resultBundleInvalid(`Result Bundle archive must be a regular non-symlink file: ${archivePath}`);
  }
  if (archiveLstat.size !== receipt.archive_size_bytes) {
    throw resultBundleInvalid(`Archive file size (${archiveLstat.size}) does not match receipt size (${receipt.archive_size_bytes})`);
  }

  let verificationResult: Awaited<ReturnType<typeof verifyResultBundleZip>>;
  try {
    verificationResult = await verifyResultBundleZip(archivePath);
  } catch (error) {
    throw resultBundleInvalid("Independent Result Bundle verification failed", error);
  }

  if (verificationResult.sha256 !== receipt.archive_sha256) {
    throw resultBundleInvalid(`Independent verifier archive sha256 '${verificationResult.sha256}' does not match receipt '${receipt.archive_sha256}'`);
  }
  if (verificationResult.reviewedEntrySetSha256 !== receipt.reviewed_entry_set_sha256) {
    throw resultBundleInvalid(`Independent verifier reviewed_entry_set_sha256 '${verificationResult.reviewedEntrySetSha256}' does not match receipt '${receipt.reviewed_entry_set_sha256}'`);
  }
  if (verificationResult.sizeBytes !== receipt.archive_size_bytes) {
    throw resultBundleInvalid(`Independent verifier archive size '${verificationResult.sizeBytes}' does not match receipt '${receipt.archive_size_bytes}'`);
  }
  if (verificationResult.entryCount !== receipt.entry_count) {
    throw resultBundleInvalid(`Independent verifier entry count '${verificationResult.entryCount}' does not match receipt '${receipt.entry_count}'`);
  }
  if (verificationResult.uncompressedBytes !== receipt.uncompressed_size_bytes) {
    throw resultBundleInvalid(`Independent verifier uncompressed size '${verificationResult.uncompressedBytes}' does not match receipt '${receipt.uncompressed_size_bytes}'`);
  }

  await assertSafeStateSource(stateDirectory, archivePath, "Result Bundle archive");
  const archiveStatBeforeSelectiveRead = await fs.stat(archivePath);
  if (archiveStatBeforeSelectiveRead.size !== receipt.archive_size_bytes) {
    throw resultBundleInvalid("Result Bundle archive changed before selective review reads");
  }

  const embeddedContracts = await loadEmbeddedReviewContracts(archivePath, receipt);
  const manifest = embeddedContracts.manifest as ResultBundleManifest;
  const manifestBuf = embeddedContracts.entries.get("manifest.json");
  if (!manifestBuf) throw resultBundleInvalid("Missing manifest.json in Result Bundle.");
  const manifestSha = sha256Hex(manifestBuf);
  if (manifestSha !== receipt.manifest_sha256) {
    throw resultBundleInvalid(`Manifest SHA mismatch: got '${manifestSha}', expected '${receipt.manifest_sha256}'`);
  }

  if (!manifest || !Array.isArray(manifest.entries)) throw resultBundleInvalid("Invalid manifest.json in Result Bundle.");
  if (manifest.run_id !== runId) throw resultBundleInvalid(`Manifest run_id '${manifest.run_id}' does not match '${runId}'`);
  if (manifest.task_id !== taskId) throw resultBundleInvalid(`Manifest task_id '${manifest.task_id}' does not match '${taskId}'`);
  if (manifest.published_commit_sha !== receipt.published_commit_sha) throw resultBundleInvalid("Manifest published_commit_sha does not match selected Result Bundle receipt.");
  if (manifest.base_commit !== receipt.base_commit) throw resultBundleInvalid("Manifest base_commit does not match selected Result Bundle receipt.");
  if (manifest.change_set_sha256 !== receipt.change_set_sha256) throw resultBundleInvalid("Manifest change_set_sha256 does not match selected Result Bundle receipt.");
  if (manifest.pull_request_number !== receipt.pull_request.number) throw resultBundleInvalid("Manifest pull_request_number does not match selected Result Bundle receipt.");
  if (manifest.spec_set_sha256 !== receipt.spec_set_sha256) throw resultBundleInvalid("Manifest spec_set_sha256 does not match selected Result Bundle receipt.");
  if (manifest.reviewed_entry_set_sha256 !== receipt.reviewed_entry_set_sha256) throw resultBundleInvalid("Manifest reviewed_entry_set_sha256 does not match selected Result Bundle receipt.");

  const bundleEntries = new Set<string>(["manifest.json"]);
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) throw resultBundleInvalid("Manifest contains an invalid entry descriptor.");
    if (bundleEntries.has(entry.path)) throw resultBundleInvalid(`Manifest contains duplicate entry path '${entry.path}'.`);
    bundleEntries.add(entry.path);
  }

  return {
    receipt,
    phase6ReceiptSha256: selectedReceiptSha256,
    reviewRound,
    receiptPath: selected.receiptPath,
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
