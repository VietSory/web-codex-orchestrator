import fsSync from "node:fs";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
import { readRunReceipt } from "../run/run-store.js";
import type { RunReceipt } from "../run/contracts.js";
import { WebReviewError } from "./contracts.js";
import { parseRunIdentity } from "./web-review-paths.js";

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
 * Resolve the trusted repository only from the canonical Phase 3 run receipt
 * and trusted local registry. There is deliberately no alternate handoff-path
 * fallback: a missing or malformed canonical run receipt is a hard failure.
 */
export async function resolveTrustedRunContext(
  runId: string,
  stateDirectory: string,
  configPath: string
): Promise<TrustedRunContext> {
  const { taskId, archiveSha256 } = parseRunIdentity(runId);

  let runReceipt: RunReceipt | undefined;
  try {
    runReceipt = await readRunReceipt(stateDirectory, taskId, archiveSha256);
  } catch (error) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Canonical run receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!runReceipt) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Canonical run receipt not found for task '${taskId}' and archive SHA '${archiveSha256}'`
    );
  }
  if (runReceipt.run_id !== runId || runReceipt.task_id !== taskId || runReceipt.archive_sha256 !== archiveSha256) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt identity does not match the requested run.");
  }
  if (!runReceipt.repository_id || typeof runReceipt.repository_id !== "string" || runReceipt.repository_id.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt repository_id is missing or empty");
  }
  if (!runReceipt.repository_path || typeof runReceipt.repository_path !== "string") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt repository_path is missing or empty");
  }

  const trustedConfig = await loadTrustedConfig(configPath);
  const resolvedRepo = trustedConfig.repositories[runReceipt.repository_id];
  if (!resolvedRepo || !resolvedRepo.path) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Repository ID '${runReceipt.repository_id}' is not registered in trusted config`
    );
  }

  let canonicalResolvedRepoPath: string;
  let canonicalStoredRepoPath: string;
  try {
    canonicalResolvedRepoPath = fsSync.realpathSync(resolvedRepo.path);
    canonicalStoredRepoPath = fsSync.realpathSync(runReceipt.repository_path);
  } catch (error) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Trusted repository path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (canonicalResolvedRepoPath !== canonicalStoredRepoPath) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Resolved repository path '${canonicalResolvedRepoPath}' does not match stored run path '${canonicalStoredRepoPath}'`
    );
  }

  // Canonical Phase 3 receipts contain these fields. Validate them whenever
  // present so later phases cannot silently switch remote identity.
  if (runReceipt.remote && runReceipt.remote !== resolvedRepo.remote) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Run receipt remote '${runReceipt.remote}' does not match trusted registry remote '${resolvedRepo.remote}'`
    );
  }
  if (runReceipt.remote_url) {
    const storedRemote = sanitizeRemoteUrl(runReceipt.remote_url);
    const expectedRemotes = resolvedRepo.expected_remote_urls.map((value) => sanitizeRemoteUrl(value));
    if (!expectedRemotes.includes(storedRemote)) {
      throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "Run receipt remote URL is not present in the trusted repository registry.");
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
