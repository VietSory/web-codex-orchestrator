import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { readRunReceipt } from "../run/run-store.js";
import type { RunReceipt } from "../run/contracts.js";
import { WebReviewError } from "./contracts.js";

export interface TrustedRunContext {
  taskId: string;
  archiveSha256: string;
  runReceipt: RunReceipt;
  trustedConfig: TrustedConfig;
  resolvedRepo: {
    path: string;
    remote: string;
    expected_remote_urls: string[];
    fetch_policy: string;
  };
  trustedRepoPath: string;
}

/**
 * Resolve exact trusted repository context from run identity (P0-01).
 * Never picks the first config entry by default. Parses <task-id>:<archive-sha256>,
 * validates Phase 3 run receipt, and resolves the exact repository_id in trusted config.
 */
export async function resolveTrustedRunContext(
  runId: string,
  stateDirectory: string,
  configPath: string
): Promise<TrustedRunContext> {
  const parts = runId.split(":");
  if (parts.length !== 2) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Invalid run ID format '${runId}': expected '<task-id>:<archive-sha256>'`
    );
  }
  const taskId = parts[0]!;
  const archiveSha256 = parts[1]!;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Invalid task ID or archive SHA256 in run ID '${runId}'`
    );
  }

  // Load run receipt from stateDirectory
  let runReceipt = await readRunReceipt(stateDirectory, taskId, archiveSha256);
  if (!runReceipt) {
    // Fallback: check handoff/runs directory if stateDirectory/runs doesn't contain it directly
    const handoffReceiptPath = path.join(path.resolve(stateDirectory), "handoff", "runs", taskId, archiveSha256, "run.json");
    try {
      const st = await fs.lstat(handoffReceiptPath);
      if (!st.isSymbolicLink() && st.isFile()) {
        const raw = await fs.readFile(handoffReceiptPath, "utf8");
        runReceipt = JSON.parse(raw) as RunReceipt;
      }
    } catch {
      // Ignore
    }
  }

  if (!runReceipt) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Run receipt not found for task '${taskId}' and archive SHA '${archiveSha256}'`
    );
  }

  if (runReceipt.run_id !== runId) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Run receipt run_id '${runReceipt.run_id}' mismatch with expected '${runId}'`
    );
  }

  if (!runReceipt.repository_id || typeof runReceipt.repository_id !== "string" || runReceipt.repository_id.trim() === "") {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Run receipt repository_id is missing or empty`
    );
  }

  const trustedConfig = await loadTrustedConfig(configPath);
  const resolvedRepo = trustedConfig.repositories[runReceipt.repository_id];

  if (!resolvedRepo || !resolvedRepo.path) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Repository ID '${runReceipt.repository_id}' is not registered in trusted config`
    );
  }

  const canonicalResolvedRepoPath = fsSync.realpathSync(resolvedRepo.path);
  if (runReceipt.repository_path) {
    let canonicalStoredRepoPath: string | undefined;
    try {
      canonicalStoredRepoPath = fsSync.realpathSync(runReceipt.repository_path);
    } catch {
      // If stored path does not exist, use raw
      canonicalStoredRepoPath = path.resolve(runReceipt.repository_path);
    }
    if (canonicalResolvedRepoPath !== canonicalStoredRepoPath) {
      throw new WebReviewError(
        "WEB_REVIEW_REPOSITORY_DRIFT",
        `Resolved repository path '${canonicalResolvedRepoPath}' does not match stored run path '${canonicalStoredRepoPath}'`
      );
    }
  }

  return {
    taskId,
    archiveSha256,
    runReceipt,
    trustedConfig,
    resolvedRepo,
    trustedRepoPath: canonicalResolvedRepoPath,
  };
}
