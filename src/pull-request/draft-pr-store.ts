import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DraftPullRequestError, type DraftPullRequestReceipt } from "./contracts.js";

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function assertReceipt(value: unknown): asserts value is DraftPullRequestReceipt {
  if (!isRecord(value)) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "The receipt must be an object.");
  }

  const {
    receipt_version, run_id, state, repository_owner, repository_name, base_branch,
    head_branch, expected_head_sha, git_publish_receipt_sha256, request_sha256, title,
    body_sha256, draft_required, create_post_attempted, pull_number, pull_url,
    observed_head_sha, observed_base_branch, observed_state, observed_draft,
    conflict_reason, created_at, updated_at, create_attempted_at, opened_at, conflict_at
  } = value as any;

  if (
    receipt_version !== "1.0" ||
    typeof run_id !== "string" ||
    (state !== "READY_FOR_CREATE" && state !== "CREATE_UNCERTAIN" && state !== "OPEN" && state !== "CONFLICT") ||
    typeof repository_owner !== "string" ||
    typeof repository_name !== "string" ||
    typeof base_branch !== "string" ||
    typeof head_branch !== "string" ||
    typeof expected_head_sha !== "string" || !SHA256.test(expected_head_sha) ||
    typeof git_publish_receipt_sha256 !== "string" || !SHA256.test(git_publish_receipt_sha256) ||
    typeof request_sha256 !== "string" || !SHA256.test(request_sha256) ||
    typeof title !== "string" ||
    typeof body_sha256 !== "string" || !SHA256.test(body_sha256) ||
    draft_required !== true ||
    typeof create_post_attempted !== "boolean" ||
    (pull_number !== null && (typeof pull_number !== "number" || pull_number <= 0)) ||
    (pull_url !== null && typeof pull_url !== "string") ||
    (observed_head_sha !== null && (typeof observed_head_sha !== "string" || !SHA256.test(observed_head_sha))) ||
    (observed_base_branch !== null && typeof observed_base_branch !== "string") ||
    (observed_state !== null && observed_state !== "open" && observed_state !== "closed") ||
    (observed_draft !== null && typeof observed_draft !== "boolean") ||
    (conflict_reason !== null && !["MULTIPLE_CANDIDATES", "WRONG_REPOSITORY", "WRONG_BASE", "WRONG_HEAD_BRANCH", "WRONG_HEAD_SHA", "NOT_OPEN", "NOT_DRAFT", "MERGED", "INVALID_CREATE_RESPONSE", "OPEN_PR_MUTATED"].includes(conflict_reason as string)) ||
    typeof created_at !== "string" || Number.isNaN(Date.parse(created_at)) ||
    typeof updated_at !== "string" || Number.isNaN(Date.parse(updated_at)) ||
    !isNullableTimestamp(create_attempted_at) ||
    !isNullableTimestamp(opened_at) ||
    !isNullableTimestamp(conflict_at)
  ) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Invalid schema.");
  }

  // Ensure strict field count to reject unknown fields
  const expectedKeys = new Set([
    "receipt_version", "run_id", "state", "repository_owner", "repository_name", "base_branch",
    "head_branch", "expected_head_sha", "git_publish_receipt_sha256", "request_sha256", "title",
    "body_sha256", "draft_required", "create_post_attempted", "pull_number", "pull_url",
    "observed_head_sha", "observed_base_branch", "observed_state", "observed_draft",
    "conflict_reason", "created_at", "updated_at", "create_attempted_at", "opened_at", "conflict_at"
  ]);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.size || !actualKeys.every(k => expectedKeys.has(k))) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Unknown fields in receipt.");
  }

  // State invariants
  if (state === "READY_FOR_CREATE") {
    if (pull_number !== null || pull_url !== null || observed_head_sha !== null || observed_base_branch !== null || observed_state !== null || observed_draft !== null || conflict_reason !== null || opened_at !== null || conflict_at !== null) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "READY_FOR_CREATE has unexpected fields.");
    }
    if (create_post_attempted && create_attempted_at === null) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "create_attempted_at must be set if create_post_attempted is true.");
    }
  } else if (state === "CREATE_UNCERTAIN") {
    if (!create_post_attempted || create_attempted_at === null || conflict_reason !== null || opened_at !== null || conflict_at !== null) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "CREATE_UNCERTAIN has invalid fields.");
    }
  } else if (state === "OPEN") {
    if (pull_number === null || pull_number <= 0 || pull_url === null || observed_head_sha !== expected_head_sha || observed_base_branch !== base_branch || observed_state !== "open" || observed_draft !== true || opened_at === null || conflict_reason !== null || conflict_at !== null) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "OPEN state invariants violated.");
    }
  } else if (state === "CONFLICT") {
    if (conflict_reason === null || conflict_at === null) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "CONFLICT state requires reason and timestamp.");
    }
  }
}

async function assertCanonicalDirectory(directory: string, create: boolean): Promise<boolean> {
  const resolved = path.resolve(directory);
  if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });

  try {
    const [info, canonical] = await Promise.all([lstat(resolved), realpath(resolved)]);
    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolved) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Directory must be a canonical real directory.");
    }
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularOrMissing(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt must be a regular non-symlink file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function readDraftPullRequestReceipt(receiptPath: string): Promise<DraftPullRequestReceipt | null> {
  if (!await assertCanonicalDirectory(path.dirname(receiptPath), false)) return null;
  await assertRegularOrMissing(receiptPath);

  let text: string;
  try {
    text = await readFile(receiptPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  if (Buffer.byteLength(text, "utf8") > 65536) {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt is not valid JSON.");
  }

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
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeDraftPullRequestReceipt(receiptPath: string, receipt: DraftPullRequestReceipt): Promise<void> {
  assertReceipt(receipt);

  const directory = path.dirname(receiptPath);
  await assertCanonicalDirectory(directory, true);
  await assertRegularOrMissing(receiptPath);

  const temporaryPath = path.join(directory, `.${path.basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`);

  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const data = `${JSON.stringify(receipt, null, 2)}\n`;
    if (Buffer.byteLength(data, "utf8") > 65536) {
      throw new DraftPullRequestError("PR_RECEIPT_INVALID", "Receipt is too large to write.");
    }
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(temporaryPath, receiptPath);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}
