import fsSync from "node:fs";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
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

function readBoundedRegularFileSync(filePath: string, maximumBytes: number, label: string): Buffer {
  const before = fsSync.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if (before.size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  }

  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | null = null;
  try {
    descriptor = fsSync.openSync(filePath, fsSync.constants.O_RDONLY | noFollow);
    const opened = fsSync.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error(`${label} changed identity or size during open.`);
    }
    if (opened.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
    }

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fsSync.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`${label} was truncated while being read.`);
      }
      offset += bytesRead;
    }

    const probe = Buffer.alloc(1);
    const extraBytes = fsSync.readSync(descriptor, probe, 0, 1, opened.size);
    if (extraBytes !== 0) {
      throw new Error(`${label} grew while being read.`);
    }

    const after = fsSync.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new Error(`${label} changed while being read.`);
    }

    const pathAfter = fsSync.lstatSync(filePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size
    ) {
      throw new Error(`${label} path changed while being read.`);
    }

    return buffer;
  } finally {
    if (descriptor !== null) fsSync.closeSync(descriptor);
  }
}

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
      const candidateBytes = readBoundedRegularFileSync(
        candidatePath,
        MAX_SIBLING_RECEIPT_BYTES,
        `Sibling run receipt '${candidatePath}'`
      );
      const parsed = JSON.parse(candidateBytes.toString("utf8")) as { run_id?: unknown };
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

function assertLexicallyStateOwned(stateDirectory: string, candidate: string, label: string): string {
  const root = path.resolve(stateDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `${label} must remain below the configured WCO state root.`);
  }
  return resolved;
}

async function assertExistingStateOwnedDirectoryWhenPresent(stateDirectory: string, candidate: string, label: string): Promise<void> {
  const resolved = assertLexicallyStateOwned(stateDirectory, candidate, label);
  try {
    const stat = fsSync.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `${label} must be a real directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof WebReviewError) throw error;
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `Cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await assertExistingStatePathIsSafe(stateDirectory, resolved, "directory");
  } catch (error) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `${label} escaped or crossed an unsafe state path: ${error instanceof Error ? error.message : String(error)}`);
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

  let runReceipt: RunReceipt;
  try {
    await assertExistingStatePathIsSafe(stateDirectory, canonicalRunPath, "file");
    const runBytes = readBoundedRegularFileSync(
      canonicalRunPath,
      MAX_CANONICAL_RUN_RECEIPT_BYTES,
      "Canonical run receipt"
    );
    const parsed: unknown = JSON.parse(runBytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Canonical run receipt must contain a JSON object.");
    }
    runReceipt = parsed as RunReceipt;
  } catch (error) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Canonical run receipt cannot be safely read: ${error instanceof Error ? error.message : String(error)}`
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
  if (!runReceipt.worktree_path || typeof runReceipt.worktree_path !== "string" || runReceipt.worktree_path.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt worktree_path is missing or empty");
  }
  if (!runReceipt.accepted_bundle_path || typeof runReceipt.accepted_bundle_path !== "string" || runReceipt.accepted_bundle_path.trim() === "") {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Run receipt accepted_bundle_path is missing or empty");
  }

  await assertExistingStateOwnedDirectoryWhenPresent(stateDirectory, runReceipt.worktree_path, "Phase 3 worktree path");
  await assertExistingStateOwnedDirectoryWhenPresent(stateDirectory, runReceipt.accepted_bundle_path, "Accepted Task Bundle path");

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
