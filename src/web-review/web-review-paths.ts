// Path construction and security validation for Phase 7 Web Review Verdict Processing
import fs from "node:fs/promises";
import path from "node:path";
import { WebReviewError } from "./contracts.js";

export const VERDICT_FILENAME = "web-review-verdict.json";
export const RECEIPT_FILENAME = "web-review-receipt.json";
export const DECISION_EVENT_FILENAME = "decision-event.json";
export const REVISION_REQUEST_FILENAME = "revision-request.json";
export const LOCK_FILENAME = "web-review.lock";

export interface ParsedRunIdentity {
  taskId: string;
  archiveSha256: string;
}

/** Parse and strictly validate run ID format (<task-id>:<archive-sha256>). */
export function parseRunIdentity(runId: string): ParsedRunIdentity {
  if (!runId || typeof runId !== "string") {
    throw new WebReviewError("WEB_REVIEW_INVALID_RUN_ID", "runId must be a non-empty string.");
  }
  const parts = runId.split(":");
  if (parts.length !== 2) {
    throw new WebReviewError("WEB_REVIEW_INVALID_RUN_ID", `Invalid run ID format: '${runId}'. Expected <task-id>:<archive-sha256>`);
  }
  const [taskId, archiveSha256] = parts;
  // Keep the Phase 7 parser exactly aligned with the canonical run-store task-id contract.
  if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new WebReviewError("WEB_REVIEW_INVALID_RUN_ID", `Unsafe or invalid task ID: '${taskId}'`);
  }
  if (!archiveSha256 || !/^[a-f0-9]{64}$/.test(archiveSha256)) {
    throw new WebReviewError("WEB_REVIEW_INVALID_RUN_ID", `Archive SHA-256 must be 64 lowercase hex characters: '${archiveSha256}'`);
  }
  return { taskId, archiveSha256 };
}

export function formatRoundNumber(round: number): string {
  if (!Number.isInteger(round) || round < 1 || round > 4) {
    throw new WebReviewError("WEB_REVIEW_INVALID_ROUND", `Invalid review round: ${round}. Must be an integer between 1 and 4.`);
  }
  return String(round).padStart(2, "0");
}

export interface ReviewRoundPaths {
  taskReviewsDir: string;
  roundDir: string;
  verdictPath: string;
  receiptPath: string;
  decisionEventPath: string;
  revisionRequestPath: string;
  lockPath: string;
  relativeRoundDir: string;
}

function assertLexicallyContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WebReviewError("WEB_REVIEW_ATTEMPTED_PATH_ESCAPE", `Review path escaped state directory: ${target}`);
  }
}

async function assertDirectoryEntry(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink()) {
    throw new WebReviewError("WEB_REVIEW_ATTEMPTED_PATH_ESCAPE", `Review lifecycle directory must not be a symbolic link: ${directoryPath}`);
  }
  if (!stat.isDirectory()) {
    throw new WebReviewError("WEB_REVIEW_ATTEMPTED_PATH_ESCAPE", `Review lifecycle path must be a directory: ${directoryPath}`);
  }
}

async function assertRealContainment(stateDirectory: string, roundDirectory: string): Promise<void> {
  const realState = await fs.realpath(stateDirectory);
  const realRound = await fs.realpath(roundDirectory);
  assertLexicallyContained(realState, realRound);
}

/**
 * Prepare the Phase 7 round directory one component at a time.
 * Existing symlinks, junction-like symbolic entries, and non-directories are
 * rejected instead of being followed by recursive mkdir/write operations.
 */
export async function prepareReviewRoundDirectory(
  stateDirectory: string,
  roundDirectory: string
): Promise<void> {
  const resolvedState = path.resolve(stateDirectory);
  const resolvedRound = path.resolve(roundDirectory);
  assertLexicallyContained(resolvedState, resolvedRound);
  await assertDirectoryEntry(resolvedState);

  const relative = path.relative(resolvedState, resolvedRound);
  let current = resolvedState;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await assertDirectoryEntry(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      await assertDirectoryEntry(current);
    }
  }

  await assertRealContainment(resolvedState, resolvedRound);
}

/**
 * Validate an already-existing round directory without creating anything.
 * Returns false when the directory does not exist. Unsafe existing ancestors
 * fail closed.
 */
export async function reviewRoundDirectoryExistsAndIsSafe(
  stateDirectory: string,
  roundDirectory: string
): Promise<boolean> {
  const resolvedState = path.resolve(stateDirectory);
  const resolvedRound = path.resolve(roundDirectory);
  assertLexicallyContained(resolvedState, resolvedRound);
  await assertDirectoryEntry(resolvedState);

  const relative = path.relative(resolvedState, resolvedRound);
  let current = resolvedState;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await assertDirectoryEntry(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  await assertRealContainment(resolvedState, resolvedRound);
  return true;
}

export function resolveReviewRoundPaths(
  stateDirectory: string,
  runId: string,
  round: number
): ReviewRoundPaths {
  const resolvedStateDir = path.resolve(stateDirectory);
  const { taskId, archiveSha256 } = parseRunIdentity(runId);
  const roundPadded = formatRoundNumber(round);

  const relativeRoundDir = path.join(
    "handoff",
    "reviews",
    "runs",
    taskId,
    archiveSha256,
    "rounds",
    roundPadded
  ).replace(/\\/g, "/");

  const roundDir = path.resolve(resolvedStateDir, relativeRoundDir);
  assertLexicallyContained(resolvedStateDir, roundDir);

  const taskReviewsDir = path.dirname(path.dirname(roundDir));
  return {
    taskReviewsDir,
    roundDir,
    verdictPath: path.join(roundDir, VERDICT_FILENAME),
    receiptPath: path.join(roundDir, RECEIPT_FILENAME),
    decisionEventPath: path.join(roundDir, DECISION_EVENT_FILENAME),
    revisionRequestPath: path.join(roundDir, REVISION_REQUEST_FILENAME),
    lockPath: path.join(roundDir, LOCK_FILENAME),
    relativeRoundDir,
  };
}
