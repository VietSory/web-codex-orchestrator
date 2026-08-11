import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../run/run-store.js";
import { DEFAULT_REVIEWER, parseReviewerSelection, type ReviewerSelection } from "./reviewer-selection.js";

const MAX_REVIEW_MODE_BYTES = 4 * 1024;

interface StoredReviewMode {
  schema_version: "1.0";
  reviewer: "sol" | "terra";
  reasoning_effort: ReviewerSelection["reasoning_effort"];
  updated_at: string;
}

export function reviewModePath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "ui", "review-mode.json");
}

export async function readReviewMode(stateDirectory: string): Promise<ReviewerSelection> {
  const target = reviewModePath(stateDirectory);
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_REVIEWER };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_REVIEW_MODE_BYTES) throw new Error("REVIEW_MODE_UNSAFE: reviewer setting must be a bounded regular file.");
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<StoredReviewMode>;
  if (parsed.schema_version !== "1.0" || typeof parsed.reviewer !== "string" || typeof parsed.reasoning_effort !== "string") throw new Error("REVIEW_MODE_INVALID: reviewer setting is malformed.");
  return parseReviewerSelection(parsed.reviewer, parsed.reasoning_effort);
}

export async function writeReviewMode(stateDirectory: string, selection: ReviewerSelection, now: () => Date = () => new Date()): Promise<void> {
  const normalized = parseReviewerSelection(selection.kind, selection.reasoning_effort);
  const value: StoredReviewMode = { schema_version: "1.0", reviewer: normalized.kind, reasoning_effort: normalized.reasoning_effort, updated_at: now().toISOString() };
  await atomicWriteJson(reviewModePath(stateDirectory), value);
}
