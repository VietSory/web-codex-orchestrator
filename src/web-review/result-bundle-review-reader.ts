// Phase 6 Result Bundle reader and verification wrapper for Phase 7
import fs from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import crypto from "node:crypto";
import { WebReviewError } from "./contracts.js";
import { parseRunIdentity } from "./web-review-paths.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { verifyResultBundleZip } from "../result-bundle/zip-verifier.js";
import type { ResultBundleReceipt, ResultBundleManifest } from "../result-bundle/contracts.js";

export interface LoadedResultBundle {
  receipt: ResultBundleReceipt;
  archivePath: string;
  manifest: ResultBundleManifest;
  bundleEntries: Set<string>;
  reviewEntries: Map<string, Buffer>;
  acceptanceData: unknown;
  testMatrixData: unknown;
  validationData: unknown;
  riskPolicyData: unknown;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Load and independently verify Phase 6 Result Bundle.
 * Safely reads review-required entries into memory without disk extraction.
 */
export async function loadAndVerifyResultBundle(
  stateDirectory: string,
  runId: string
): Promise<LoadedResultBundle> {
  const { taskId, archiveSha256: expectedArchiveSha } = parseRunIdentity(runId);
  const p6Paths = resultBundlePaths(stateDirectory, taskId, expectedArchiveSha);

  // 1. Read Phase 6 receipt
  const receipt = await readResultBundleReceipt(p6Paths.receiptPath);
  if (!receipt) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Phase 6 receipt not found for run ID '${runId}'`);
  }

  // 2. Require state READY_FOR_WEB_REVIEW
  if (receipt.state !== "READY_FOR_WEB_REVIEW") {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Phase 6 receipt state is '${receipt.state}', expected 'READY_FOR_WEB_REVIEW'`
    );
  }

  // 3. Require all binding fields to be non-null
  if (
    !receipt.archive_relative_path ||
    !receipt.archive_sha256 ||
    !receipt.manifest_sha256 ||
    !receipt.spec_set_sha256 ||
    !receipt.reviewed_entry_set_sha256 ||
    !receipt.published_commit_sha ||
    !receipt.pull_request ||
    !receipt.pull_request.head_sha
  ) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Phase 6 receipt has null or incomplete binding fields.");
  }

  if (receipt.archive_sha256 !== expectedArchiveSha) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Archive SHA mismatch in receipt: got '${receipt.archive_sha256}', expected '${expectedArchiveSha}'`
    );
  }

  // 4. Verify Result Bundle ZIP is a regular file and not a symlink
  const absoluteStateDir = path.resolve(stateDirectory);
  const archivePath = path.resolve(absoluteStateDir, receipt.archive_relative_path);

  let lstat: import("node:fs").Stats;
  try {
    lstat = await fs.lstat(archivePath);
  } catch (err) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Result Bundle archive file not found: ${archivePath}`);
  }

  if (lstat.isSymbolicLink()) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Result Bundle archive must not be a symbolic link: ${archivePath}`);
  }
  if (!lstat.isFile()) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Result Bundle archive must be a regular file: ${archivePath}`);
  }

  if (lstat.size !== receipt.archive_size_bytes) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Archive file size (${lstat.size}) does not match receipt size (${receipt.archive_size_bytes})`
    );
  }

  // 5. Reopen and verify ZIP using independent verifyResultBundleZip()
  const verificationResult = await verifyResultBundleZip(archivePath);

  if (verificationResult.sha256 !== receipt.archive_sha256) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Independent verifier archive sha256 '${verificationResult.sha256}' does not match receipt '${receipt.archive_sha256}'`
    );
  }

  if (verificationResult.reviewedEntrySetSha256 !== receipt.reviewed_entry_set_sha256) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Independent verifier reviewed_entry_set_sha256 '${verificationResult.reviewedEntrySetSha256}' does not match receipt '${receipt.reviewed_entry_set_sha256}'`
    );
  }

  // 6. Read entries into in-memory map without extracting to disk
  const bundleEntries = new Set<string>();
  const reviewEntries = new Map<string, Buffer>();

  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        return reject(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Cannot open ZIP: ${openErr?.message ?? "unknown"}`));
      }

      zipfile.readEntry();

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryPath = entry.fileName;
        bundleEntries.add(entryPath);

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            zipfile.close();
            return reject(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Cannot read entry '${entryPath}'`));
          }

          const chunks: Buffer[] = [];
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("error", (err: Error) => {
            zipfile.close();
            reject(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Error reading entry '${entryPath}': ${err.message}`));
          });
          readStream.on("end", () => {
            reviewEntries.set(entryPath, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => {
        zipfile.close();
        resolve();
      });

      zipfile.on("error", (err: Error) => {
        reject(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `ZIP stream error: ${err.message}`));
      });
    });
  });

  // 7. Verify manifest JSON & sha256
  const manifestBuf = reviewEntries.get("manifest.json");
  if (!manifestBuf) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Missing manifest.json in Result Bundle.");
  }
  const manifestSha = sha256Hex(manifestBuf);
  if (manifestSha !== receipt.manifest_sha256) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Manifest SHA mismatch: got '${manifestSha}', expected '${receipt.manifest_sha256}'`
    );
  }

  let manifest: ResultBundleManifest;
  try {
    manifest = JSON.parse(manifestBuf.toString("utf8"));
  } catch (err) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Invalid manifest.json in Result Bundle.");
  }

  // 8. Safely parse specification files
  const parseJsonEntry = (entryPath: string): unknown => {
    const buf = reviewEntries.get(entryPath);
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      return null;
    }
  };

  const acceptanceData = parseJsonEntry("task/acceptance.json");
  const testMatrixData = parseJsonEntry("task/test-matrix.json");
  const validationData = parseJsonEntry("task/validation.json");
  const riskPolicyData = parseJsonEntry("task/risk-policy.json");

  return {
    receipt,
    archivePath,
    manifest,
    bundleEntries,
    reviewEntries,
    acceptanceData,
    testMatrixData,
    validationData,
    riskPolicyData,
  };
}
