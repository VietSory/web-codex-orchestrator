import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, runDirectory } from "../run/run-store.js";
import { DEFAULT_REVIEWER, parseReviewerSelection, type ReviewerSelection } from "./reviewer-selection.js";

const MAX_REVIEW_MODE_BYTES = 4 * 1024;

interface StoredReviewMode {
  schema_version: "1.0";
  reviewer: "sol" | "terra";
  reasoning_effort: ReviewerSelection["reasoning_effort"];
  updated_at: string;
}

function splitRunId(runId: string): { taskId: string; archiveSha256: string } {
  const separator = runId.lastIndexOf(":");
  const taskId = runId.slice(0, separator);
  const archiveSha256 = runId.slice(separator + 1);
  if (separator < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("REVIEW_MODE_RUN_ID_INVALID: run identity is unsafe.");
  return { taskId, archiveSha256 };
}

export function reviewModePath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "ui", "review-mode.json");
}

export function runReviewModePath(stateDirectory: string, runId: string): string {
  const identity = splitRunId(runId);
  return path.join(runDirectory(stateDirectory, identity.taskId, identity.archiveSha256), "reviewer-mode.json");
}

async function readStoredMode(target: string, missing: ReviewerSelection | null): Promise<ReviewerSelection | null> {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing ? { ...missing } : null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_REVIEW_MODE_BYTES) throw new Error("REVIEW_MODE_UNSAFE: reviewer setting must be a bounded regular file.");
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<StoredReviewMode>;
  if (parsed.schema_version !== "1.0" || typeof parsed.reviewer !== "string" || typeof parsed.reasoning_effort !== "string") throw new Error("REVIEW_MODE_INVALID: reviewer setting is malformed.");
  return parseReviewerSelection(parsed.reviewer, parsed.reasoning_effort);
}

function storedValue(selection: ReviewerSelection, now: () => Date): StoredReviewMode {
  const normalized = parseReviewerSelection(selection.kind, selection.reasoning_effort);
  return { schema_version: "1.0", reviewer: normalized.kind, reasoning_effort: normalized.reasoning_effort, updated_at: now().toISOString() };
}

export async function readReviewMode(stateDirectory: string): Promise<ReviewerSelection> {
  return (await readStoredMode(reviewModePath(stateDirectory), DEFAULT_REVIEWER))!;
}

export async function writeReviewMode(stateDirectory: string, selection: ReviewerSelection, now: () => Date = () => new Date()): Promise<void> {
  await atomicWriteJson(reviewModePath(stateDirectory), storedValue(selection, now));
}

export async function readRunReviewMode(stateDirectory: string, runId: string): Promise<ReviewerSelection | null> {
  return await readStoredMode(runReviewModePath(stateDirectory, runId), null);
}

/** Freeze the task's chosen reviewer once. A replay must match exactly. */
export async function freezeRunReviewMode(stateDirectory: string, runId: string, selection: ReviewerSelection, now: () => Date = () => new Date()): Promise<ReviewerSelection> {
  const normalized = parseReviewerSelection(selection.kind, selection.reasoning_effort);
  const existing = await readRunReviewMode(stateDirectory, runId);
  if (existing) {
    if (existing.kind !== normalized.kind || existing.model !== normalized.model || existing.reasoning_effort !== normalized.reasoning_effort) throw new Error("REVIEW_MODE_RUN_DRIFT: reviewer selection is already frozen differently for this run.");
    return existing;
  }
  await atomicWriteJson(runReviewModePath(stateDirectory, runId), storedValue(normalized, now));
  const persisted = await readRunReviewMode(stateDirectory, runId);
  if (!persisted || persisted.kind !== normalized.kind || persisted.model !== normalized.model || persisted.reasoning_effort !== normalized.reasoning_effort) throw new Error("REVIEW_MODE_RUN_DRIFT: frozen reviewer selection could not be re-attested.");
  return persisted;
}

export async function effectiveRunReviewMode(stateDirectory: string, runId: string): Promise<ReviewerSelection> {
  return (await readRunReviewMode(stateDirectory, runId)) ?? await readReviewMode(stateDirectory);
}
