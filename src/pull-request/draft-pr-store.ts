import { constants as fsConstants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DraftPullRequestError, type DraftPullRequestReceipt } from "./contracts.js";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function assertReceipt(value: unknown): asserts value is DraftPullRequestReceipt {
  if (!isRecord(value)) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "The receipt must be an object.");

  const {
    receipt_version, run_id, state, repository_owner, repository_name, base_branch,
    head_branch, expected_head_sha, git_publish_receipt_sha256, request_sha256, title,
    body_sha256, draft_required, create_post_attempted, pull_number, pull_url,
    observed_head_sha, observed_base_branch, observed_state, observed_draft,
    conflict_reason, created_at, updated_at, create_attempted_at, opened_at, conflict_at,
  } = value as any;

  if (
    receipt_version !== "1.0" ||
    typeof run_id !== "string" || run_id.length === 0 || run_id.length > 512 ||
    (state !== "READY_FOR_CREATE" && state !== "CREATE_UNCERTAIN" && state !== "OPEN" && state !== "CONFLICT") ||
    typeof repository_owner !== "string" || repository_owner.length === 0 || repository_owner.length > 256 ||
    typeof repository_name !== "string" || repository_name.length === 0 || repository_name.length > 256 ||
    typeof base_branch !== "string" || base_branch.length === 0 || base_branch.length > 1024 ||
    typeof head_branch !== "string" || head_branch.length === 0 || head_branch.length > 1024 ||
    typeof expected_head_sha !== "string" || !SHA1.test(expected_head_sha) ||
    typeof git_publish_receipt_sha256 !== "string" || !SHA256.test(git_publish_receipt_sha256) ||
    typeof request_sha256 !== "string" || !SHA256.test(request_sha256) ||
    typeof title !== "string" || title.length > 4096 ||
    typeof body_sha256 !== "string" || !SHA256.test(body_sha256) ||
    draft_required !== true ||
    typeof create_post_attempted !== "boolean" ||
    (pull_number !== null && (typeof pull_number !== "number" || !Number.isInteger(pull_number) || pull_number <= 0)) ||
    (pull_url !== null && (typeof pull_url !== "string" || pull_url.length > 8192)) ||
    (observed_head_sha !== null && (typeof observed_head_sha !== "string" || !SHA1.test(observed_head_sha))) ||
    (observed_base_branch !== null && (typeof observed_base_branch !== "string" || observed_base_branch.length > 1024)) ||
    (observed_state !== null && observed_state !== "open" && observed_state !== "closed") ||
    (observed_draft !== null && typeof observed_draft !== "boolean") ||
    (conflict_reason !== null && !["MULTIPLE_CANDIDATES", "WRONG_REPOSITORY", "WRONG_BASE", "WRONG_HEAD_BRANCH", "WRONG_HEAD_SHA", "NOT_OPEN", "NOT_DRAFT", "MERGED", "INVALID_CREATE_RESPONSE", "OPEN_PR_MUTATED"].includes(conflict_reason as string)) ||
    typeof created_at !== "string" || Number.isNaN(Date.parse(created_at)) ||
    typeof updated_at !== "string" || Number.isNaN(Date.parse(updated_at)) ||
    !isNullableTimestamp(create_attempted_at) || !isNullableTimestamp(opened_at) || !isNullableTimestamp(conflict_at)
  ) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Invalid schema.");
  }

  const expectedKeys = new Set([
    "receipt_version", "run_id", "state", "repository_owner", "repository_name", "base_branch",
    "head_branch", "expected_head_sha", "git_publish_receipt_sha256", "request_sha256", "title",
    "body_sha256", "draft_required", "create_post_attempted", "pull_number", "pull_url",
    "observed_head_sha", "observed_base_branch", "observed_state", "observed_draft",
    "conflict_reason", "created_at", "updated_at", "create_attempted_at", "opened_at", "conflict_at",
  ]);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.size || !actualKeys.every((key) => expectedKeys.has(key))) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Unknown fields in receipt.");
  }

  if (state === "READY_FOR_CREATE") {
    if (pull_number !== null || pull_url !== null || observed_head_sha !== null || observed_base_branch !== null || observed_state !== null || observed_draft !== null || conflict_reason !== null || opened_at !== null || conflict_at !== null) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "READY_FOR_CREATE has unexpected fields.");
    if (create_post_attempted && create_attempted_at === null) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "create_attempted_at must be set if create_post_attempted is true.");
  } else if (state === "CREATE_UNCERTAIN") {
    if (!create_post_attempted || create_attempted_at === null || conflict_reason !== null || opened_at !== null || conflict_at !== null) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "CREATE_UNCERTAIN has invalid fields.");
  } else if (state === "OPEN") {
    if (pull_number === null || pull_number <= 0 || pull_url === null || observed_head_sha !== expected_head_sha || observed_base_branch !== base_branch || observed_state !== "open" || observed_draft !== true || opened_at === null || conflict_reason !== null || conflict_at !== null) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "OPEN state invariants violated.");
  } else if (state === "CONFLICT") {
    if (conflict_reason === null || conflict_at === null) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "CONFLICT state requires reason and timestamp.");
  }
}

async function assertCanonicalDirectory(directory: string, create: boolean): Promise<boolean> {
  const resolved = path.resolve(directory);
  if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });
  try {
    const [info, canonical] = await Promise.all([lstat(resolved), realpath(resolved)]);
    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolved) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Directory must be a canonical real directory.");
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularOrMissing(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readStableReceiptBytes(receiptPath: string): Promise<Buffer | null> {
  let pathBefore: Stats;
  try { pathBefore = await lstat(receiptPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_RECEIPT_BYTES) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt must be a bounded regular non-symlink file.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(receiptPath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", `Cannot safely open receipt: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_RECEIPT_BYTES) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(receiptPath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readDraftPullRequestReceipt(receiptPath: string): Promise<DraftPullRequestReceipt | null> {
  if (!await assertCanonicalDirectory(path.dirname(receiptPath), false)) return null;
  const bytes = await readStableReceiptBytes(receiptPath);
  if (bytes === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt is not valid JSON."); }
  assertReceipt(parsed);
  return parsed;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeDraftPullRequestReceipt(receiptPath: string, receipt: DraftPullRequestReceipt): Promise<void> {
  assertReceipt(receipt);
  const directory = path.dirname(receiptPath);
  await assertCanonicalDirectory(directory, true);
  await assertRegularOrMissing(receiptPath);
  const data = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_RECEIPT_BYTES) throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt is too large to write.");
  const temporaryPath = path.join(directory, `.${path.basename(receiptPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularOrMissing(receiptPath);
    await rename(temporaryPath, receiptPath);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}
