import { createHash } from "node:crypto";
import { lstat, realpath as defaultRealpath } from "node:fs/promises";
import path from "node:path";
import {
  GitPublishError,
  type GitCommandResult,
  type GitPublishReceipt,
  type GitPublishRequest,
  type GitPublisherOptions,
  type VerifiedChangeSet,
} from "./contracts.js";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_COMMIT_MESSAGE = 4_096;
const MAX_PATHS = 2_000;

type CommandFailureCode =
  | "PUBLISH_COMMIT_FAILED"
  | "PUBLISH_PUSH_FAILED"
  | "PUBLISH_PUSH_PREFLIGHT_FAILED"
  | "PUBLISH_REMOTE_VERIFICATION_FAILED";

interface RepositoryBoundary {
  head: string;
  branch: string;
  remoteUrl: string;
}

type RegularFileMode = "100644" | "100755";

interface SnapshotEntry {
  path: string;
  state: "file" | "deleted";
  mode: RegularFileMode | null;
  blobOid: string | null;
}

function bounded(value: string, maximum = 4_096): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function failCommand(code: CommandFailureCode, message: string, result: GitCommandResult): never {
  throw new GitPublishError(code, message, {
    exit_code: result.exitCode,
    signal: result.signal ?? null,
    stderr_tail: bounded(result.stderr.slice(-4_096)),
    timed_out: result.timed_out === true,
    cancelled: result.cancelled === true,
    stdout_truncated: result.stdout_truncated === true,
    stderr_truncated: result.stderr_truncated === true,
  });
}

function normalizeRelativePath(value: string): string {
  if (value.length === 0 || value.length > 4_096 || value.includes("\u0000") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new GitPublishError("PUBLISH_REQUEST_INVALID", "Publish paths must be bounded relative NUL-free paths.");
  }
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GitPublishError("PUBLISH_REQUEST_INVALID", "Publish paths must not contain empty, dot, or parent segments.");
  }
  return normalized;
}

function normalizedPathSet(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_PATHS) throw new GitPublishError("PUBLISH_REQUEST_INVALID", `The publish path count must be between 1 and ${MAX_PATHS}.`);
  const normalized = paths.map(normalizeRelativePath);
  if (new Set(normalized).size !== normalized.length) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "Publish paths must be unique.");
  return normalized.sort((left, right) => left.localeCompare(right));
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseNulList(value: string): string[] {
  if (value.length === 0) return [];
  return value.split("\u0000").filter((entry) => entry.length > 0).map(normalizeRelativePath).sort((left, right) => left.localeCompare(right));
}

function snapshotDigest(entries: readonly SnapshotEntry[]): string {
  const digest = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(entry.path); digest.update("\u0000");
    digest.update(entry.state); digest.update("\u0000");
    digest.update(entry.mode ?? ""); digest.update("\u0000");
    digest.update(entry.blobOid ?? ""); digest.update("\u0000");
  }
  return digest.digest("hex");
}

function assertRequest(request: GitPublishRequest): void {
  if (request.run_id.length === 0 || request.run_id.length > 512 || request.run_id.includes("\u0000")) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The publish run ID is invalid.");
  if (!path.isAbsolute(request.worktree_path) || request.worktree_path.includes("\u0000")) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The publish worktree path must be absolute and NUL-free.");
  if (!GIT_OBJECT_ID.test(request.base_commit)) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The publish base commit is invalid.");
  if (request.branch_name.length === 0 || request.branch_name.length > 1_024 || request.branch_name.includes("\u0000") || request.branch_name.startsWith("-") || request.branch_name.includes("..") || request.branch_name.endsWith("/") || request.branch_name.endsWith(".lock")) throw new GitPublishError("PUBLISH_BRANCH_POLICY_VIOLATION", "The publish branch name is unsafe.");
  if (request.allowed_branch_prefix.length === 0 || !request.branch_name.startsWith(request.allowed_branch_prefix) || request.deny_direct_push_branches.includes(request.branch_name)) throw new GitPublishError("PUBLISH_BRANCH_POLICY_VIOLATION", "The publish branch violates the trusted branch policy.");
  if (!SAFE_REMOTE_NAME.test(request.remote_name)) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The publish remote name is invalid.");
  if (request.allowed_remote_url.length === 0 || request.allowed_remote_url.length > 8_192 || request.allowed_remote_url.includes("\u0000") || /https?:\/\/[^/@\s]+@/i.test(request.allowed_remote_url)) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The allowed remote URL is invalid or contains credentials.");
  if (!SHA256.test(request.expected_change_set_sha256)) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The expected Phase 4 change-set digest is invalid.");
  normalizedPathSet(request.expected_paths);
  if (request.commit_message.trim().length === 0 || request.commit_message.length > MAX_COMMIT_MESSAGE || request.commit_message.includes("\u0000")) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "The commit message is empty, oversized, or contains NUL.");
  if (request.allow_force_push !== false || request.allow_remote_branch_delete !== false) throw new GitPublishError("PUBLISH_REQUEST_INVALID", "Phase 5A never permits force-push or remote branch deletion.");
}

function initialReceipt(request: GitPublishRequest, approvedSnapshotSha256: string, now: () => Date): GitPublishReceipt {
  const timestamp = now().toISOString();
  return {
    publish_version: "1.1", run_id: request.run_id, state: "READY_FOR_COMMIT", base_commit: request.base_commit,
    branch_name: request.branch_name, remote_name: request.remote_name, allowed_remote_url: request.allowed_remote_url,
    change_set_sha256: request.expected_change_set_sha256, expected_paths: normalizedPathSet(request.expected_paths),
    approved_snapshot_sha256: approvedSnapshotSha256, commit_sha: null, remote_branch_sha: null,
    created_at: timestamp, updated_at: timestamp, committed_at: null, pushed_at: null,
  };
}

function assertReceiptMatches(receipt: GitPublishReceipt, request: GitPublishRequest): void {
  const expectedPaths = normalizedPathSet(request.expected_paths);
  if (receipt.publish_version !== "1.1" || receipt.run_id !== request.run_id || receipt.base_commit !== request.base_commit || receipt.branch_name !== request.branch_name || receipt.remote_name !== request.remote_name || receipt.allowed_remote_url !== request.allowed_remote_url || receipt.change_set_sha256 !== request.expected_change_set_sha256 || !equalStringArrays(receipt.expected_paths, expectedPaths) || !SHA256.test(receipt.approved_snapshot_sha256)) {
    throw new GitPublishError("PUBLISH_RECEIPT_INCONSISTENT", "The persisted publish receipt does not match the current request.");
  }
}

async function requireSuccess(runner: GitPublisherOptions["runner"], args: readonly string[], cwd: string, code: CommandFailureCode, message: string): Promise<GitCommandResult> {
  const result = await runner.run(args, cwd);
  if (result.exitCode !== 0) failCommand(code, message, result);
  return result;
}

export class GitPublisher {
  private readonly now: () => Date;
  private readonly resolveRealpath: (value: string) => Promise<string>;

  constructor(private readonly options: GitPublisherOptions) {
    this.now = options.now ?? (() => new Date());
    this.resolveRealpath = options.realpath ?? defaultRealpath;
  }

  private async assertCanonicalWorktree(worktreePath: string): Promise<string> {
    const resolved = path.resolve(worktreePath);
    let info; let canonical;
    try { [info, canonical] = await Promise.all([lstat(resolved), this.resolveRealpath(resolved)]); }
    catch { throw new GitPublishError("PUBLISH_WORKTREE_UNSAFE", "The publish worktree is missing or cannot be resolved."); }
    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolved) throw new GitPublishError("PUBLISH_WORKTREE_UNSAFE", "The publish worktree must be a canonical real directory.");
    return resolved;
  }

  private async readRepositoryBoundary(request: GitPublishRequest, cwd: string): Promise<RepositoryBoundary> {
    const [head, branch, remoteUrl] = await Promise.all([
      requireSuccess(this.options.runner, ["rev-parse", "HEAD"], cwd, "PUBLISH_COMMIT_FAILED", "The worktree HEAD could not be read."),
      requireSuccess(this.options.runner, ["branch", "--show-current"], cwd, "PUBLISH_COMMIT_FAILED", "The current worktree branch could not be read."),
      requireSuccess(this.options.runner, ["remote", "get-url", "--push", request.remote_name], cwd, "PUBLISH_REMOTE_VERIFICATION_FAILED", "The configured push remote could not be read."),
    ]);
    const boundary = { head: head.stdout.trim(), branch: branch.stdout.trim(), remoteUrl: remoteUrl.stdout.trim() };
    if (!GIT_OBJECT_ID.test(boundary.head)) throw new GitPublishError("PUBLISH_BASE_MISMATCH", "The worktree HEAD is not a full Git object ID.");
    if (boundary.branch !== request.branch_name) throw new GitPublishError("PUBLISH_BRANCH_POLICY_VIOLATION", "The current worktree branch does not match the approved delivery branch.");
    if (boundary.remoteUrl !== request.allowed_remote_url) throw new GitPublishError("PUBLISH_REMOTE_MISMATCH", "The configured push URL does not match the trusted delivery remote.");
    return boundary;
  }

  private async readRemoteBranch(request: GitPublishRequest, cwd: string): Promise<string | null> {
    const reference = `refs/heads/${request.branch_name}`;
    const result = await this.options.runner.run(["ls-remote", "--heads", request.remote_name, reference], cwd);
    if (result.exitCode !== 0) failCommand("PUBLISH_REMOTE_VERIFICATION_FAILED", "The remote branch could not be inspected.", result);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) throw new GitPublishError("PUBLISH_REMOTE_VERIFICATION_FAILED", "The remote branch lookup returned an ambiguous result.");
    const [sha, ref] = lines[0]!.split(/\s+/);
    if (!sha || !ref || !GIT_OBJECT_ID.test(sha) || ref !== reference) throw new GitPublishError("PUBLISH_REMOTE_VERIFICATION_FAILED", "The remote branch lookup returned an invalid result.");
    return sha;
  }

  private async calculateSnapshot(request: GitPublishRequest, cwd: string): Promise<{ digest: string; entries: SnapshotEntry[] }> {
    const entries: SnapshotEntry[] = [];
    for (const filePath of normalizedPathSet(request.expected_paths)) {
      const result = await requireSuccess(this.options.runner, ["ls-files", "--stage", "--", filePath], cwd, "PUBLISH_COMMIT_FAILED", "The approved file snapshot could not be read.");
      const line = result.stdout.trim();
      if (!line) { entries.push({ path: filePath, state: "deleted", mode: null, blobOid: null }); continue; }
      const match = /^(100644|100755) ([0-9a-f]{40,64}) \d+\t/.exec(line);
      if (!match) throw new GitPublishError("PUBLISH_INDEX_MISMATCH", `The staged entry for '${filePath}' is unsupported or ambiguous.`);
      entries.push({ path: filePath, state: "file", mode: match[1] as RegularFileMode, blobOid: match[2]! });
    }
    return { digest: snapshotDigest(entries), entries };
  }

  private async assertOnlyExpectedPaths(request: GitPublishRequest, cwd: string): Promise<void> {
    const expectedPaths = normalizedPathSet(request.expected_paths);
    const status = await requireSuccess(this.options.runner, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, "PUBLISH_COMMIT_FAILED", "The worktree status could not be inspected.");
    const actual = parseNulList(status.stdout).map((entry) => entry.length > 3 ? normalizeRelativePath(entry.slice(3)) : entry);
    const unique = [...new Set(actual)].sort((left, right) => left.localeCompare(right));
    if (!equalStringArrays(unique, expectedPaths)) throw new GitPublishError("PUBLISH_STAGE_MISMATCH", "The worktree changed-path set does not match the exact approved path set.");
  }

  async publish(request: GitPublishRequest, previousReceipt?: GitPublishReceipt | null): Promise<GitPublishReceipt> {
    assertRequest(request);
    const cwd = await this.assertCanonicalWorktree(request.worktree_path);
    const boundary = await this.readRepositoryBoundary(request, cwd);
    const verified = await this.options.inspectVerifiedChangeSet();
    if (verified.change_set_sha256 !== request.expected_change_set_sha256 || !equalStringArrays([...verified.paths].sort(), normalizedPathSet(request.expected_paths))) throw new GitPublishError("PUBLISH_CHANGE_SET_STALE", "The verified change-set no longer matches the publication request.");
    await this.assertOnlyExpectedPaths(request, cwd);
    const snapshot = await this.calculateSnapshot(request, cwd);
    let receipt = previousReceipt ?? initialReceipt(request, snapshot.digest, this.now);
    if (previousReceipt) assertReceiptMatches(previousReceipt, request);
    else await this.options.persistReceipt(receipt);
    if (receipt.approved_snapshot_sha256 !== snapshot.digest) throw new GitPublishError("PUBLISH_APPROVED_SNAPSHOT_MISSING", "The exact approved file snapshot changed before publication.");

    if (receipt.state === "PUSHED") {
      if (!receipt.commit_sha || receipt.remote_branch_sha !== receipt.commit_sha) throw new GitPublishError("PUBLISH_RECOVERY_FAILED", "The completed publish receipt is internally inconsistent.");
      const remote = await this.readRemoteBranch(request, cwd);
      if (remote !== receipt.commit_sha) throw new GitPublishError("PUBLISH_RECOVERY_FAILED", "The remote branch no longer matches the completed publish receipt.");
      return receipt;
    }

    if (receipt.state === "READY_FOR_COMMIT") {
      if (boundary.head !== request.base_commit) throw new GitPublishError("PUBLISH_BASE_MISMATCH", "The worktree HEAD is no longer at the exact approved base commit.");
      const remoteBefore = await this.readRemoteBranch(request, cwd);
      if (remoteBefore !== null) throw new GitPublishError("PUBLISH_REMOTE_BRANCH_EXISTS", "The publication branch already exists remotely before the approved first push.");
      await requireSuccess(this.options.runner, ["add", "--", ...normalizedPathSet(request.expected_paths)], cwd, "PUBLISH_COMMIT_FAILED", "The approved paths could not be staged.");
      await this.assertOnlyExpectedPaths(request, cwd);
      const stagedSnapshot = await this.calculateSnapshot(request, cwd);
      if (stagedSnapshot.digest !== receipt.approved_snapshot_sha256) throw new GitPublishError("PUBLISH_INDEX_MISMATCH", "The staged snapshot differs from the exact approved snapshot.");
      await requireSuccess(this.options.runner, ["commit", "--no-verify", "-m", request.commit_message], cwd, "PUBLISH_COMMIT_FAILED", "The approved commit could not be created.");
      const committed = await requireSuccess(this.options.runner, ["rev-parse", "HEAD"], cwd, "PUBLISH_COMMIT_FAILED", "The new commit SHA could not be read.");
      const commitSha = committed.stdout.trim();
      if (!GIT_OBJECT_ID.test(commitSha) || commitSha === request.base_commit) throw new GitPublishError("PUBLISH_COMMIT_MISMATCH", "The created commit SHA is invalid.");
      receipt = { ...receipt, state: "COMMITTED", commit_sha: commitSha, updated_at: this.now().toISOString(), committed_at: this.now().toISOString() };
      await this.options.persistReceipt(receipt);
    }

    if (!receipt.commit_sha) throw new GitPublishError("PUBLISH_RECOVERY_FAILED", "A committed receipt is missing commit_sha.");
    const currentHead = await requireSuccess(this.options.runner, ["rev-parse", "HEAD"], cwd, "PUBLISH_PUSH_PREFLIGHT_FAILED", "The committed worktree HEAD could not be read.");
    if (currentHead.stdout.trim() !== receipt.commit_sha) throw new GitPublishError("PUBLISH_COMMIT_MISMATCH", "The worktree HEAD differs from the persisted committed SHA.");
    const current = await this.options.inspectVerifiedChangeSet();
    if (current.change_set_sha256 !== request.expected_change_set_sha256 || !equalStringArrays([...current.paths].sort(), normalizedPathSet(request.expected_paths))) throw new GitPublishError("PUBLISH_CHANGE_SET_STALE", "The verified change-set changed before push.");
    const remoteBeforePush = await this.readRemoteBranch(request, cwd);
    if (remoteBeforePush !== null && remoteBeforePush !== receipt.commit_sha) throw new GitPublishError("PUBLISH_REMOTE_BRANCH_EXISTS", "The remote publication branch changed before push.");
    if (remoteBeforePush === null) {
      await requireSuccess(this.options.runner, ["push", "--porcelain", request.remote_name, `${receipt.commit_sha}:refs/heads/${request.branch_name}`], cwd, "PUBLISH_PUSH_FAILED", "The approved commit could not be pushed.");
    }
    const remoteAfterPush = await this.readRemoteBranch(request, cwd);
    if (remoteAfterPush !== receipt.commit_sha) throw new GitPublishError("PUBLISH_REMOTE_VERIFICATION_FAILED", "The remote branch does not equal the exact pushed commit SHA.");
    receipt = { ...receipt, state: "PUSHED", remote_branch_sha: remoteAfterPush, updated_at: this.now().toISOString(), pushed_at: this.now().toISOString() };
    await this.options.persistReceipt(receipt);
    return receipt;
  }
}
