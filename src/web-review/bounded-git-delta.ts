import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { WebReviewError } from "./contracts.js";

const execFileAsync = promisify(execFile);

export const GIT_DELTA_TIMEOUT_MS = 5000;
export const GIT_DELTA_MAX_BYTES = 512 * 1024; // 512 KiB

/**
 * Bounded Git diff delta computation in exact trusted repository (P0-07).
 * Runs `git diff-tree --no-commit-id -r --name-only -z <previousCommit> <currentCommit>`.
 * Parses NUL-delimited entries (-z) cleanly supporting filenames with newlines.
 * Fails closed on any error, non-zero exit code, timeout or output cap.
 */
export async function computeBoundedGitDelta(
  trustedRepoPath: string,
  previousCommit: string,
  currentCommit: string
): Promise<Set<string>> {
  if (!fs.existsSync(trustedRepoPath)) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Trusted repository path does not exist: '${trustedRepoPath}'`
    );
  }

  const sanitizedEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  // 1. Verify commits exist
  for (const commit of [previousCommit, currentCommit]) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
        cwd: trustedRepoPath,
        timeout: GIT_DELTA_TIMEOUT_MS,
        maxBuffer: GIT_DELTA_MAX_BYTES,
        env: sanitizedEnv,
      });
    } catch (e) {
      throw new WebReviewError(
        "WEB_REVIEW_OPERATIONAL_ERROR",
        `Git commit verification failed for '${commit}': ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 2. Execute git diff-tree with NUL delimiter (-z)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", previousCommit, currentCommit],
      {
        cwd: trustedRepoPath,
        timeout: GIT_DELTA_TIMEOUT_MS,
        maxBuffer: GIT_DELTA_MAX_BYTES,
        env: sanitizedEnv,
      }
    );

    const changedFiles = new Set<string>();
    if (stdout.length > 0) {
      const items = stdout.split("\0");
      for (const item of items) {
        if (item.length > 0) {
          const normalized = item.replace(/\\/g, "/");
          changedFiles.add(normalized);
        }
      }
    }
    return changedFiles;
  } catch (e) {
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Git diff-tree execution failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
