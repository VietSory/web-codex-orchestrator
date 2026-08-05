// Path helpers for Phase 6 result bundle output
import path from "node:path";

/** Output subdirectory for all result bundle artifacts */
export const RESULT_BUNDLE_SUBDIR = "handoff";

/** Receipt filename */
export const RESULT_BUNDLE_RECEIPT_NAME = "result-bundle.json";

/** Lock filename */
export const RESULT_BUNDLE_LOCK_NAME = "result-bundle.lock";

/** Archive filename template */
export function resultBundleArchiveFilename(taskId: string, publishedCommitSha: string): string {
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
  const directory = path.join(stateDirectory, RESULT_BUNDLE_SUBDIR, "runs", taskId, archiveSha256);
  return {
    directory,
    receiptPath: path.join(directory, RESULT_BUNDLE_RECEIPT_NAME),
    lockPath: path.join(directory, RESULT_BUNDLE_LOCK_NAME),
    archivePath: (filename: string) => path.join(directory, filename),
  };
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
