import { constants as fsConstants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, runDirectory } from "../run/run-store.js";
import { readStableFile } from "../shared/stable-file.js";
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

async function assertSafeRunAncestorChain(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const archiveDirectory = path.dirname(resolved);
  const taskDirectory = path.dirname(archiveDirectory);
  const runsDirectory = path.dirname(taskDirectory);
  const stateRoot = path.dirname(runsDirectory);
  if (path.basename(runsDirectory) !== "runs") throw new Error("REVIEW_MODE_UNSAFE: frozen reviewer authority is outside the canonical state/runs hierarchy.");
  for (const directory of [stateRoot, runsDirectory, taskDirectory, archiveDirectory]) {
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("REVIEW_MODE_UNSAFE: frozen reviewer authority ancestor must be a real directory.");
  }
  return true;
}

function parseStoredMode(bytes: Buffer): ReviewerSelection {
  let parsed: Partial<StoredReviewMode>;
  try { parsed = JSON.parse(bytes.toString("utf8")) as Partial<StoredReviewMode>; }
  catch { throw new Error("REVIEW_MODE_INVALID: reviewer setting is not valid JSON."); }
  if (parsed.schema_version !== "1.0" || typeof parsed.reviewer !== "string" || typeof parsed.reasoning_effort !== "string" || typeof parsed.updated_at !== "string" || !Number.isFinite(Date.parse(parsed.updated_at))) throw new Error("REVIEW_MODE_INVALID: reviewer setting is malformed.");
  return parseReviewerSelection(parsed.reviewer, parsed.reasoning_effort);
}

async function readStoredMode(target: string, missing: ReviewerSelection | null, runScoped = false): Promise<ReviewerSelection | null> {
  if (runScoped && !await assertSafeRunAncestorChain(target)) return missing ? { ...missing } : null;
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing ? { ...missing } : null;
    throw error;
  }
  let snapshot;
  try { snapshot = await readStableFile(target, MAX_REVIEW_MODE_BYTES); }
  catch (error) { throw new Error(`REVIEW_MODE_UNSAFE: reviewer setting could not be read as stable authority: ${error instanceof Error ? error.message : String(error)}`); }
  if (runScoped && !await assertSafeRunAncestorChain(target)) throw new Error("REVIEW_MODE_UNSAFE: frozen reviewer authority ancestry changed during read.");
  return parseStoredMode(snapshot.bytes);
}

function storedValue(selection: ReviewerSelection, now: () => Date): StoredReviewMode {
  const normalized = parseReviewerSelection(selection.kind, selection.reasoning_effort);
  return { schema_version: "1.0", reviewer: normalized.kind, reasoning_effort: normalized.reasoning_effort, updated_at: now().toISOString() };
}

function sameSelection(left: ReviewerSelection, right: ReviewerSelection): boolean {
  return left.kind === right.kind && left.model === right.model && left.reasoning_effort === right.reasoning_effort;
}

/** Create immutable per-run authority without overwrite. The temporary file is
 * fully written/fsynced first, then linked into place with no-replace semantics.
 */
async function createRunModeOnce(target: string, value: StoredReviewMode): Promise<boolean> {
  if (!await assertSafeRunAncestorChain(target)) throw new Error("REVIEW_MODE_RUN_MISSING: prepared run directory is missing; reviewer authority cannot be frozen safely.");
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (linked && !await assertSafeRunAncestorChain(target)) throw new Error("REVIEW_MODE_UNSAFE: frozen reviewer authority ancestry changed during creation.");
  return linked;
}

export async function readReviewMode(stateDirectory: string): Promise<ReviewerSelection> {
  return (await readStoredMode(reviewModePath(stateDirectory), DEFAULT_REVIEWER))!;
}

export async function writeReviewMode(stateDirectory: string, selection: ReviewerSelection, now: () => Date = () => new Date()): Promise<void> {
  await atomicWriteJson(reviewModePath(stateDirectory), storedValue(selection, now));
}

export async function readRunReviewMode(stateDirectory: string, runId: string): Promise<ReviewerSelection | null> {
  return await readStoredMode(runReviewModePath(stateDirectory, runId), null, true);
}

/** Freeze the task's chosen reviewer exactly once. Concurrent replays may only
 * converge on the same selection; a competing different selection fails closed.
 */
export async function freezeRunReviewMode(stateDirectory: string, runId: string, selection: ReviewerSelection, now: () => Date = () => new Date()): Promise<ReviewerSelection> {
  const normalized = parseReviewerSelection(selection.kind, selection.reasoning_effort);
  const existing = await readRunReviewMode(stateDirectory, runId);
  if (existing) {
    if (!sameSelection(existing, normalized)) throw new Error("REVIEW_MODE_RUN_DRIFT: reviewer selection is already frozen differently for this run.");
    return existing;
  }
  await createRunModeOnce(runReviewModePath(stateDirectory, runId), storedValue(normalized, now));
  const persisted = await readRunReviewMode(stateDirectory, runId);
  if (!persisted || !sameSelection(persisted, normalized)) throw new Error("REVIEW_MODE_RUN_DRIFT: frozen reviewer selection was created concurrently with a different value or could not be re-attested.");
  return persisted;
}

/** A prepared product run must already have immutable reviewer authority.
 * Never inherit mutable global /mode state on resume or Phase 8 revision.
 */
export async function effectiveRunReviewMode(stateDirectory: string, runId: string): Promise<ReviewerSelection> {
  const frozen = await readRunReviewMode(stateDirectory, runId);
  if (!frozen) throw new Error("REVIEW_MODE_RUN_MISSING: prepared run has no frozen reviewer authority; refusing to inherit mutable global /mode state.");
  return frozen;
}
