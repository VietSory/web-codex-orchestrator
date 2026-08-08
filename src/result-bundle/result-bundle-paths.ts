// Path helpers for Phase 6 result bundle output
import fs from "node:fs/promises";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";

/** Output subdirectory for all result bundle artifacts */
export const RESULT_BUNDLE_SUBDIR = "handoff";

/** Receipt filename */
export const RESULT_BUNDLE_RECEIPT_NAME = "result-bundle.json";

/** Lock filename */
export const RESULT_BUNDLE_LOCK_NAME = "result-bundle.lock";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Archive filename template */
export function resultBundleArchiveFilename(taskId: string, publishedCommitSha: string): string {
  if (!SAFE_TASK_ID.test(taskId) || !/^[a-f0-9]{40}$/.test(publishedCommitSha)) {
    throw new ResultBundleError("RESULT_REQUEST_INVALID", "Unsafe Result Bundle archive identity.");
  }
  const sha12 = publishedCommitSha.slice(0, 12);
  return `wco-result-${taskId}-${sha12}.zip`;
}

/** Absolute paths for result bundle artifacts */
export interface ResultBundlePaths {
  directory: string;
  receiptPath: string;
  lockPath: string;
  archivePath(filename: string): string;
}

export function resultBundlePaths(stateDirectory: string, taskId: string, archiveSha256: string): ResultBundlePaths {
  if (!SAFE_TASK_ID.test(taskId) || !SHA256.test(archiveSha256)) {
    throw new ResultBundleError("RESULT_REQUEST_INVALID", "Unsafe Result Bundle path identity.");
  }
  const root = path.resolve(stateDirectory);
  const directory = path.resolve(root, RESULT_BUNDLE_SUBDIR, "runs", taskId, archiveSha256);
  const relative = path.relative(root, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", "Result Bundle directory escapes the WCO state root.");
  }
  return {
    directory,
    receiptPath: path.join(directory, RESULT_BUNDLE_RECEIPT_NAME),
    lockPath: path.join(directory, RESULT_BUNDLE_LOCK_NAME),
    archivePath: (filename: string) => {
      if (!/^wco-result-[A-Za-z0-9._-]+-[a-f0-9]{12}\.zip$/.test(filename)) {
        throw new ResultBundleError("RESULT_REQUEST_INVALID", "Unsafe Result Bundle archive filename.");
      }
      return path.join(directory, filename);
    },
  };
}

/** Create/attest every Result Bundle state ancestor without following symlinks. */
export async function prepareResultBundleDirectory(stateDirectory: string, directory: string): Promise<void> {
  const requestedRoot = path.resolve(stateDirectory);
  await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", "WCO state root must be a real directory.");
  }
  const root = await fs.realpath(requestedRoot);
  if (root !== requestedRoot) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", "WCO state root must be a canonical non-symlink directory.");
  }
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", "Result Bundle directory escapes the WCO state root.");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", `Unsafe Result Bundle state ancestor: ${current}`);
    }
  }
  const canonical = await fs.realpath(target);
  if (canonical !== target) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", "Result Bundle directory resolves through a symbolic link.");
  }
}

/** Required entries that must be present in every result bundle */
export const REQUIRED_RESULT_BUNDLE_ENTRIES = [
  "RESULT.md",
  "REVIEW.md",
  "checksums.json",
  "evidence/acceptance.json",
  "evidence/event-summary.json",
  "evidence/execution.json",
  "evidence/git-publish.json",
  "evidence/github-draft-pr.json",
  "evidence/sol-review.json",
  "evidence/terra-review.json",
  "evidence/verification.json",
  "github/pull-request.json",
  "manifest.json",
  "repository/changed-files.json",
  "repository/deleted-files.json",
  "repository/diff.patch",
  "review/WEB-REVIEW-CONTRACT.md",
  "review/revision-request.schema.json",
  "review/web-review-policy.json",
  "review/web-review-verdict.schema.json",
  "task/PLAN.md",
  "task/README.md",
  "task/REQUEST.md",
  "task/RESEARCH.md",
  "task/RULES.md",
  "task/SOURCES.md",
  "task/VALIDATION.md",
  "task/acceptance.json",
  "task/checksums.json",
  "task/manifest.json",
  "task/risk-policy.json",
  "task/spec-lock.json",
  "task/test-matrix.json",
  "task/validation.json",
] as const;

/** Dynamic prefix for repository source entries */
export const SOURCE_ENTRY_PREFIX = "repository/source/";

/** Forbidden path prefixes in ZIP entries */
export const FORBIDDEN_ENTRY_PREFIXES = ["payload/", ".git/"];

/** Fixed DOS timestamp for canonical ZIP metadata: 1980-01-01T00:00:00 (local midnight — yazl encodes using local time fields) */
export const FIXED_ZIP_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);

/** Fixed file mode for ZIP entries: 0100644 */
export const FIXED_FILE_MODE = 0o100644;
