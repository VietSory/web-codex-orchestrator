// Git evidence collection for Phase 6 — argv-only, no shell
// Reads blobs from exact published commit; never modifies worktree.
import { ResultBundleError } from "./contracts.js";
import type { ChangedFileEntry, DeletedFileEntry } from "./contracts.js";
import crypto from "node:crypto";

export interface GitRunner {
  run(args: string[], cwd: string, options?: { env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stdoutBuffer?: Buffer }>;
  runBinary(args: string[], cwd: string): Promise<Buffer>;
}

export interface GitEvidenceOptions {
  worktreePath: string;
  baseCommit: string;
  publishedCommit: string;
  maximumDiffBytes: number;
  maximumSourceFileBytes: number;
  gitRunner: GitRunner;
}

export interface GitEvidence {
  diffPatch: Buffer;
  changedFiles: ChangedFileEntry[];
  deletedFiles: DeletedFileEntry[];
  sourceFiles: Map<string, Buffer>; // path → content bytes
  warnings: string[];
}

const FORBIDDEN_GIT_CONFIG = [
  "-c", "core.pager=",
  "-c", "core.quotePath=false",
  "-c", "diff.external=",
  "-c", "diff.textconv=",
  "-c", "diff.tool=",
];

/** Supported diff status characters */
const SUPPORTED_STATUS = new Set(["A", "M", "D"]);
const SUPPORTED_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Collect exact git evidence from the published commit.
 * Uses argv-only git commands; never executes external diff or textconv.
 */
export async function collectGitEvidence(opts: GitEvidenceOptions): Promise<GitEvidence> {
  const { worktreePath, baseCommit, publishedCommit, gitRunner } = opts;
  const warnings: string[] = [];

  // 1. Get the diff as a patch
  let diffBuffer: Buffer;
  try {
    const diffArgs = [
      ...FORBIDDEN_GIT_CONFIG,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "-z",
      `${baseCommit}..${publishedCommit}`,
      "--",
    ];
    diffBuffer = await gitRunner.runBinary(diffArgs, worktreePath);
  } catch (error) {
    throw new ResultBundleError(
      "RESULT_GIT_INSPECTION_FAILED",
      `git diff failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (diffBuffer.byteLength > opts.maximumDiffBytes) {
    throw new ResultBundleError(
      "RESULT_ARCHIVE_SIZE_LIMIT",
      `Diff size ${diffBuffer.byteLength} exceeds maximum ${opts.maximumDiffBytes} bytes.`
    );
  }

  // 2. Get list of changed files with status
  let nameStatusOut: string;
  try {
    const result = await gitRunner.run(
      [...FORBIDDEN_GIT_CONFIG, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", `${baseCommit}..${publishedCommit}`, "--"],
      worktreePath
    );
    nameStatusOut = result.stdout;
  } catch (error) {
    throw new ResultBundleError(
      "RESULT_GIT_INSPECTION_FAILED",
      `git diff --name-status failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Parse NUL-terminated name-status output
  const entries = nameStatusOut.split("\0").filter(Boolean);
  const changedFiles: ChangedFileEntry[] = [];
  const deletedFiles: DeletedFileEntry[] = [];
  const sourceFiles = new Map<string, Buffer>();
  const seenPaths = new Set<string>();

  for (let i = 0; i < entries.length; ) {
    const status = entries[i]?.trim() ?? "";
    const filePath = entries[i + 1];
    i += 2;

    if (!filePath || !status) continue;

    if (!SUPPORTED_STATUS.has(status[0] ?? "")) {
      throw new ResultBundleError(
        "RESULT_UNSUPPORTED_CHANGE_TYPE",
        `Unsupported change type '${status}' for file '${filePath}'.`
      );
    }

    // Path safety check
    if (
      filePath.startsWith("/") ||
      filePath.startsWith("..") ||
      filePath.includes("\0") ||
      filePath.includes("\\")
    ) {
      throw new ResultBundleError(
        "RESULT_SOURCE_PATH_UNSAFE",
        `Repository path is unsafe for ZIP: '${filePath}'`
      );
    }

    const normalized = filePath.normalize ? filePath.normalize("NFC") : filePath;
    const lower = normalized.toLowerCase();
    if (seenPaths.has(lower)) {
      throw new ResultBundleError(
        "RESULT_ARCHIVE_PATH_COLLISION",
        `Path collision (case or Unicode normalization): '${filePath}'`
      );
    }
    seenPaths.add(lower);

    if (status[0] === "D") {
      deletedFiles.push({ path: filePath });
    } else {
      // Read the file blob from the published commit
      let blobBuffer: Buffer;
      try {
        blobBuffer = await gitRunner.runBinary(
          [...FORBIDDEN_GIT_CONFIG, "show", `${publishedCommit}:${filePath}`],
          worktreePath
        );
      } catch (error) {
        throw new ResultBundleError(
          "RESULT_GIT_INSPECTION_FAILED",
          `Failed to read blob ${filePath}@${publishedCommit}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (blobBuffer.byteLength > opts.maximumSourceFileBytes) {
        throw new ResultBundleError(
          "RESULT_SOURCE_FILE_TOO_LARGE",
          `Source file '${filePath}' is ${blobBuffer.byteLength} bytes, exceeds limit.`
        );
      }

      // Mode is authority: if Git cannot attest it exactly, fail closed.
      let mode: string;
      try {
        const lsResult = await gitRunner.run(
          [...FORBIDDEN_GIT_CONFIG, "--literal-pathspecs", "ls-tree", publishedCommit, "--", filePath],
          worktreePath
        );
        const lsLines = lsResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);
        if (lsLines.length !== 1) throw new Error("git ls-tree did not return exactly one literal path record");
        const modeMatch = /^(\d{6})\s/.exec(lsLines[0]!);
        if (!modeMatch?.[1]) throw new Error("git ls-tree did not return an exact mode");
        mode = modeMatch[1];
      } catch (error) {
        throw new ResultBundleError(
          "RESULT_GIT_INSPECTION_FAILED",
          `Failed to attest mode for ${filePath}@${publishedCommit}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!SUPPORTED_FILE_MODES.has(mode)) {
        throw new ResultBundleError(
          "RESULT_UNSUPPORTED_CHANGE_TYPE",
          `File '${filePath}' has unsupported Git mode ${mode}.`
        );
      }

      const sha256 = crypto.createHash("sha256").update(blobBuffer).digest("hex");

      changedFiles.push({
        path: filePath,
        mode,
        sha256,
        size_bytes: blobBuffer.byteLength,
      });
      sourceFiles.set(filePath, blobBuffer);
    }
  }

  // Generate clean diff (text, no binary markers) for the patch entry.
  // The fallback remains bounded by the already-checked binary diff, while a
  // successful clean diff must independently satisfy the same configured cap.
  let cleanDiff: Buffer;
  try {
    const patchArgs = [
      ...FORBIDDEN_GIT_CONFIG,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      `${baseCommit}..${publishedCommit}`,
      "--",
    ];
    cleanDiff = await gitRunner.runBinary(patchArgs, worktreePath);
  } catch {
    cleanDiff = diffBuffer;
  }

  if (cleanDiff.byteLength > opts.maximumDiffBytes) {
    throw new ResultBundleError(
      "RESULT_ARCHIVE_SIZE_LIMIT",
      `Clean diff size ${cleanDiff.byteLength} exceeds maximum ${opts.maximumDiffBytes} bytes.`
    );
  }

  return {
    diffPatch: cleanDiff,
    changedFiles,
    deletedFiles,
    sourceFiles,
    warnings,
  };
}
