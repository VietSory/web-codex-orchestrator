import fsSync from "node:fs";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
import { readRunReceipt } from "../run/run-store.js";
import type { RunReceipt } from "../run/contracts.js";
import { WebReviewError } from "./contracts.js";
import { assertExistingStatePathIsSafe, parseRunIdentity } from "./web-review-paths.js";

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

const MAX_SIBLING_RUN_DIRECTORIES = 4096;
const MAX_SIBLING_RECEIPT_BYTES = 1024 * 1024;
const MAX_CANONICAL_RUN_RECEIPT_BYTES = 1024 * 1024;

function rejectDuplicateRunIdentity(
  stateDirectory: string,
  taskId: string,
  canonicalArchiveSha: string,
  runId: string
): void {
  const taskRunsDirectory = path.join(path.resolve(stateDirectory), "runs", taskId);
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(taskRunsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Cannot inspect run identity registry: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (entries.length > MAX_SIBLING_RUN_DIRECTORIES) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Run identity registry exceeds bounded directory limit ${MAX_SIBLING_RUN_DIRECTORIES}`
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === canonicalArchiveSha || !/^[a-f0-9]{64}$/.test(entry.name)) continue;

    const candidatePath = path.join(taskRunsDirectory, entry.name, "run.json");
    try {
      const stat = fsSync.lstatSync(candidatePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SIBLING_RECEIPT_BYTES) continue;
      const parsed = JSON.parse(fsSync.readFileSync(candidatePath, "utf8")) as { run_id?: unknown };
      if (parsed?.run_id === runId) {
        throw new WebReviewError(
          "WEB_REVIEW_OPERATIONAL_ERROR",
          `Conflicting duplicate run receipt claims canonical run_id '${runId}' from archive directory '${entry.name}'`
        );
      }
    } catch (error) {
      if (error instanceof WebReviewError) throw error;
      continue;
    }
  }
}

/**
 * Resolve the trusted repository only from the canonical Phase 3 run receipt
 * and trusted local registry. A canonical run receipt must carry the exact
 * repository path and remote identity established during preparation.
 */
export async function resolveTrustedRunContext(
  runId: string,
  stateDirectory: string,
  configPath: string
): Promise<TrustedRunContext> {
  const { taskId, archiveSha256 } = parseRunIdentity(runId);
  const canonicalRunPath = path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "run.json");

  try {
    await assertExistingStatePathIsSafe(stateDirectory, canonicalRunPath, "file");
    const runStat = fsSync.statSync(canonicalRunPath);
    if (runStat.size > MAX_CANONICAL_RUN_RECEIPT_BYTES) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Canonical run receipt exceeds ${MAX_CANONICAL_RUN_RECEIPT_BYTES} bytes`
      );
    }
  } catch (error) {
    if (error instanceof WebReviewError && error.code === "WEB_REVIEW_RESULT_BUNDLE_INVALID") throw error;
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Canonical run receipt path is not safe: ${error instanceof Error ? error.message : String(error)}`
    );
  }

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
  if (!runReceipt.repository_path || typeof runReceipt.repository_path !== "string" || runReceipt.repository_path.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt repository_path is missing or empty");
  }
  if (!runReceipt.remote || typeof runReceipt.remote !== "string" || runReceipt.remote.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt remote is missing or empty");
  }
  if (!runReceipt.remote_url || typeof runReceipt.remote_url !== "string" || runReceipt.remote_url.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt remote_url is missing or empty");
  }

  rejectDuplicateRunIdentity(stateDirectory, taskId, archiveSha256, runId);

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

  if (runReceipt.remote !== resolvedRepo.remote) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Run receipt remote '${runReceipt.remote}' does not match trusted registry remote '${resolvedRepo.remote}'`
    );
  }

  let storedRemote: string;
  let expectedRemotes: string[];
  try {
    storedRemote = sanitizeRemoteUrl(runReceipt.remote_url);
    expectedRemotes = resolvedRepo.expected_remote_urls.map((value) => sanitizeRemoteUrl(value));
  } catch (error) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Run receipt remote identity cannot be normalized: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!expectedRemotes.includes(storedRemote)) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "Run receipt remote URL is not present in the trusted repository registry.");
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
