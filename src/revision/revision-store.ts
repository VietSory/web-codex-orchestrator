import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { REVISION_STATES, RevisionError, type RevisionReceipt, type RevisionState } from "./contracts.js";
import { assertExistingRevisionPathSafe } from "./revision-paths.js";

export const MAX_REVISION_ARTIFACT_BYTES = 2 * 1024 * 1024;
const VALID_STATES = new Set<RevisionState>(REVISION_STATES);

async function assertSafeParent(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  const stat = await fs.lstat(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RevisionError("REVISION_STATE_UNSAFE", `Revision artifact parent is unsafe: ${parent}`);
  }
}

async function readBounded(filePath: string, missingAllowed: boolean): Promise<Buffer | null> {
  let before: import("node:fs").Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RevisionError("REVISION_STATE_INVALID", `Cannot inspect revision artifact '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new RevisionError("REVISION_STATE_UNSAFE", `Revision artifact must be a regular non-symlink file: ${filePath}`);
  if (before.size > MAX_REVISION_ARTIFACT_BYTES) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact exceeds ${MAX_REVISION_ARTIFACT_BYTES} bytes: ${filePath}`);

  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact changed during open: ${filePath}`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact was truncated during read: ${filePath}`);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extra } = await handle.read(probe, 0, 1, opened.size);
    if (extra !== 0) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact grew during read: ${filePath}`);
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact changed during read: ${filePath}`);
    const pathAfter = await fs.lstat(filePath);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== opened.size) throw new RevisionError("REVISION_STATE_INVALID", `Revision artifact path changed during read: ${filePath}`);
    return buffer;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function requireSha(obj: Record<string, unknown>, field: string, length: 40 | 64, nullable = false): void {
  const value = obj[field];
  if (nullable && value === null) return;
  const pattern = length === 64 ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
  if (typeof value !== "string" || !pattern.test(value)) throw new RevisionError("REVISION_STATE_INVALID", `${field} must be ${nullable ? "null or " : ""}a ${length}-hex digest.`);
}

export function assertRevisionReceipt(value: unknown): asserts value is RevisionReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt must be an object.");
  const obj = value as Record<string, unknown>;
  if (obj.phase_version !== "1.0") throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt phase_version must be 1.0.");
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0 || obj.run_id.length > 256) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt run_id is invalid.");
  if (!Number.isInteger(obj.revision_round) || Number(obj.revision_round) < 1 || Number(obj.revision_round) > 3) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt revision_round is invalid.");
  if (!VALID_STATES.has(obj.state as RevisionState)) throw new RevisionError("REVISION_STATE_INVALID", `Revision receipt state is invalid: ${String(obj.state)}`);
  for (const field of ["spec_set_sha256", "revision_request_sha256", "previous_result_bundle_sha256", "previous_result_receipt_sha256", "previous_verdict_sha256", "initial_refs_sha256"] as const) requireSha(obj, field, 64);
  requireSha(obj, "revision_change_set_sha256", 64, true);
  requireSha(obj, "approved_snapshot_sha256", 64, true);
  requireSha(obj, "result_bundle_sha256", 64, true);
  requireSha(obj, "result_manifest_sha256", 64, true);
  for (const field of ["previous_published_commit_sha", "previous_pr_head_sha"] as const) requireSha(obj, field, 40);
  requireSha(obj, "new_published_commit_sha", 40, true);
  requireSha(obj, "remote_branch_sha", 40, true);
  if (typeof obj.pull_request_number !== "number" || !Number.isInteger(obj.pull_request_number) || Number(obj.pull_request_number) < 1) throw new RevisionError("REVISION_STATE_INVALID", "pull_request_number is invalid.");
  if (typeof obj.branch_name !== "string" || obj.branch_name.length === 0 || typeof obj.base_branch !== "string" || obj.base_branch.length === 0) throw new RevisionError("REVISION_STATE_INVALID", "Revision branch bindings are invalid.");
  if (typeof obj.worktree_path !== "string" || obj.worktree_path.length === 0) throw new RevisionError("REVISION_STATE_INVALID", "Revision worktree_path is invalid.");
  if (!Number.isInteger(obj.next_review_round) || Number(obj.next_review_round) !== Number(obj.revision_round) + 1) throw new RevisionError("REVISION_STATE_INVALID", "next_review_round must equal revision_round + 1.");
  if (!Array.isArray(obj.revision_paths) || obj.revision_paths.length > 2000 || obj.revision_paths.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4096)) throw new RevisionError("REVISION_STATE_INVALID", "revision_paths is invalid or unbounded.");
  if (!Array.isArray(obj.errors) || obj.errors.length > 32) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt errors are invalid or unbounded.");
  for (const item of obj.errors) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt error entry is invalid.");
    const entry = item as Record<string, unknown>;
    if (typeof entry.code !== "string" || entry.code.length > 256 || typeof entry.message !== "string" || entry.message.length > 8192) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt error diagnostics are oversized or invalid.");
  }
}

export async function readRevisionReceipt(stateDirectory: string, receiptPath: string): Promise<RevisionReceipt | null> {
  try {
    await assertExistingRevisionPathSafe(stateDirectory, receiptPath, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.toLowerCase().includes("no such file")) return null;
    throw error;
  }
  const buffer = await readBounded(receiptPath, true);
  if (!buffer) return null;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    assertRevisionReceipt(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof RevisionError) throw error;
    throw new RevisionError("REVISION_STATE_INVALID", `Cannot parse revision receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeRevisionReceipt(receiptPath: string, receipt: RevisionReceipt): Promise<void> {
  assertRevisionReceipt(receipt);
  await assertSafeParent(receiptPath);
  const content = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (content.byteLength > MAX_REVISION_ARTIFACT_BYTES) throw new RevisionError("REVISION_STATE_INVALID", "Revision receipt exceeds the artifact cap.");
  const temporary = `${receiptPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, receiptPath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw new RevisionError("REVISION_OPERATIONAL_ERROR", `Cannot persist revision receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeCanonicalRevisionArtifact(filePath: string, value: unknown | Buffer): Promise<{ buffer: Buffer; sha256: string }> {
  await assertSafeParent(filePath);
  const buffer = Buffer.isBuffer(value) ? value : canonicalJsonBuffer(value);
  if (buffer.byteLength > MAX_REVISION_ARTIFACT_BYTES) throw new RevisionError("REVISION_STATE_INVALID", `Canonical revision artifact exceeds ${MAX_REVISION_ARTIFACT_BYTES} bytes.`);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  try {
    await fs.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RevisionError("REVISION_OPERATIONAL_ERROR", `Cannot write revision artifact: ${error instanceof Error ? error.message : String(error)}`);
    const existing = await readBounded(filePath, false);
    if (!existing?.equals(buffer)) throw new RevisionError("REVISION_STATE_INVALID", `Immutable revision artifact already exists with different bytes: ${filePath}`);
  }
  return { buffer, sha256 };
}

export async function readCanonicalRevisionArtifact(filePath: string): Promise<Buffer | null> {
  return readBounded(filePath, true);
}
