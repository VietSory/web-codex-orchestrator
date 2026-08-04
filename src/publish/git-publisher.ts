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
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_COMMIT_MESSAGE = 4_096;
const MAX_PATHS = 2_000;

function bounded(value: string, maximum = 4_096): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function failCommand(
  code:
    | "PUBLISH_COMMIT_FAILED"
    | "PUBLISH_PUSH_FAILED"
    | "PUBLISH_REMOTE_VERIFICATION_FAILED",
  message: string,
  result: GitCommandResult,
): never {
  throw new GitPublishError(code, message, {
    exit_code: result.exitCode,
    stderr_tail: bounded(result.stderr.slice(-4_096)),
  });
}

function normalizeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "Publish paths must be non-empty relative NUL-free paths.",
    );
  }

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "Publish paths must not contain empty, dot, or parent segments.",
    );
  }

  return normalized;
}

function normalizedPathSet(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_PATHS) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      `The publish path count must be between 1 and ${MAX_PATHS}.`,
    );
  }

  const normalized = paths.map(normalizeRelativePath);

  if (new Set(normalized).size !== normalized.length) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "Publish paths must be unique.",
    );
  }

  return normalized.sort((left, right) => left.localeCompare(right));
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertRequest(request: GitPublishRequest): void {
  if (
    request.run_id.length === 0 ||
    request.run_id.length > 512 ||
    request.run_id.includes("\u0000")
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The publish run ID is invalid.",
    );
  }

  if (!path.isAbsolute(request.worktree_path) || request.worktree_path.includes("\u0000")) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The publish worktree path must be absolute and NUL-free.",
    );
  }

  if (!GIT_OBJECT_ID.test(request.base_commit)) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The publish base commit is invalid.",
    );
  }

  if (
    request.branch_name.length === 0 ||
    request.branch_name.includes("\u0000") ||
    request.branch_name.startsWith("-") ||
    request.branch_name.includes("..") ||
    request.branch_name.endsWith("/") ||
    request.branch_name.endsWith(".lock")
  ) {
    throw new GitPublishError(
      "PUBLISH_BRANCH_POLICY_VIOLATION",
      "The publish branch name is unsafe.",
    );
  }

  if (
    request.allowed_branch_prefix.length === 0 ||
    !request.branch_name.startsWith(request.allowed_branch_prefix) ||
    request.deny_direct_push_branches.includes(request.branch_name)
  ) {
    throw new GitPublishError(
      "PUBLISH_BRANCH_POLICY_VIOLATION",
      "The publish branch violates the trusted branch policy.",
    );
  }

  if (!SAFE_REMOTE_NAME.test(request.remote_name)) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The publish remote name is invalid.",
    );
  }

  if (
    request.allowed_remote_url.length === 0 ||
    request.allowed_remote_url.includes("\u0000") ||
    /https?:\/\/[^/@\s]+@/i.test(request.allowed_remote_url)
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The allowed remote URL is invalid or contains credentials.",
    );
  }

  if (!SHA256.test(request.expected_change_set_sha256)) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The expected Phase 4 change-set digest is invalid.",
    );
  }

  normalizedPathSet(request.expected_paths);

  if (
    request.commit_message.trim().length === 0 ||
    request.commit_message.length > MAX_COMMIT_MESSAGE ||
    request.commit_message.includes("\u0000")
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "The commit message is empty, oversized, or contains NUL.",
    );
  }

  if (
    request.allow_force_push !== false ||
    request.allow_remote_branch_delete !== false
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "Phase 5A never permits force-push or remote branch deletion.",
    );
  }
}

function initialReceipt(
  request: GitPublishRequest,
  now: () => Date,
): GitPublishReceipt {
  const timestamp = now().toISOString();

  return {
    publish_version: "1.0",
    run_id: request.run_id,
    state: "READY_FOR_COMMIT",
    base_commit: request.base_commit,
    branch_name: request.branch_name,
    remote_name: request.remote_name,
    allowed_remote_url: request.allowed_remote_url,
    change_set_sha256: request.expected_change_set_sha256,
    commit_sha: null,
    remote_branch_sha: null,
    created_at: timestamp,
    updated_at: timestamp,
    committed_at: null,
    pushed_at: null,
  };
}

function assertReceiptMatches(
  receipt: GitPublishReceipt,
  request: GitPublishRequest,
): void {
  if (
    receipt.publish_version !== "1.0" ||
    receipt.run_id !== request.run_id ||
    receipt.base_commit !== request.base_commit ||
    receipt.branch_name !== request.branch_name ||
    receipt.remote_name !== request.remote_name ||
    receipt.allowed_remote_url !== request.allowed_remote_url ||
    receipt.change_set_sha256 !== request.expected_change_set_sha256
  ) {
    throw new GitPublishError(
      "PUBLISH_RECEIPT_INCONSISTENT",
      "The persisted publish receipt does not match the current request.",
    );
  }
}

function parseNulList(value: string): string[] {
  if (value.length === 0) return [];
  return value.split("\u0000").filter((entry) => entry.length > 0).sort();
}

async function requireSuccess(
  runner: GitPublisherOptions["runner"],
  args: readonly string[],
  cwd: string,
  code:
    | "PUBLISH_COMMIT_FAILED"
    | "PUBLISH_PUSH_FAILED"
    | "PUBLISH_REMOTE_VERIFICATION_FAILED",
  message: string,
): Promise<GitCommandResult> {
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
    let info;
    let canonical;

    try {
      [info, canonical] = await Promise.all([
        lstat(resolved),
        this.resolveRealpath(resolved),
      ]);
    } catch {
      throw new GitPublishError(
        "PUBLISH_WORKTREE_UNSAFE",
        "The publish worktree is missing or cannot be resolved.",
      );
    }

    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolved) {
      throw new GitPublishError(
        "PUBLISH_WORKTREE_UNSAFE",
        "The publish worktree must be a canonical real directory.",
      );
    }

    return resolved;
  }

  private async readRemoteBranch(
    request: GitPublishRequest,
    cwd: string,
  ): Promise<string | null> {
    const reference = `refs/heads/${request.branch_name}`;
    const result = await this.options.runner.run(
      ["ls-remote", "--heads", request.remote_name, reference],
      cwd,
    );

    if (result.exitCode !== 0) {
      failCommand(
        "PUBLISH_REMOTE_VERIFICATION_FAILED",
        "The remote branch could not be inspected.",
        result,
      );
    }

    const line = result.stdout.trim();
    if (line.length === 0) return null;

    const [sha, remoteReference, ...extra] = line.split(/\s+/);
    if (
      extra.length > 0 ||
      !sha ||
      !GIT_OBJECT_ID.test(sha) ||
      remoteReference !== reference
    ) {
      throw new GitPublishError(
        "PUBLISH_REMOTE_VERIFICATION_FAILED",
        "The remote returned an unexpected branch record.",
      );
    }

    return sha;
  }

  private async assertRepositoryBoundary(
    request: GitPublishRequest,
    cwd: string,
    expectedHead: string,
  ): Promise<void> {
    const [head, branch, remoteUrl] = await Promise.all([
      requireSuccess(
        this.options.runner,
        ["rev-parse", "HEAD"],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The worktree HEAD could not be read.",
      ),
      requireSuccess(
        this.options.runner,
        ["branch", "--show-current"],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The current worktree branch could not be read.",
      ),
      requireSuccess(
        this.options.runner,
        ["remote", "get-url", "--push", request.remote_name],
        cwd,
        "PUBLISH_REMOTE_VERIFICATION_FAILED",
        "The configured push remote could not be read.",
      ),
    ]);

    if (head.stdout.trim() !== expectedHead) {
      throw new GitPublishError(
        "PUBLISH_BASE_MISMATCH",
        "The worktree HEAD no longer matches the expected publish boundary.",
      );
    }

    if (branch.stdout.trim() !== request.branch_name) {
      throw new GitPublishError(
        "PUBLISH_BRANCH_POLICY_VIOLATION",
        "The current worktree branch does not match the approved delivery branch.",
      );
    }

    if (remoteUrl.stdout.trim() !== request.allowed_remote_url) {
      throw new GitPublishError(
        "PUBLISH_REMOTE_MISMATCH",
        "The configured push URL does not match the trusted delivery remote.",
      );
    }
  }

  private async assertVerifiedChangeSet(
    request: GitPublishRequest,
  ): Promise<VerifiedChangeSet> {
    const current = await this.options.inspectVerifiedChangeSet();
    const expectedPaths = normalizedPathSet(request.expected_paths);
    const currentPaths = normalizedPathSet(current.paths);

    if (
      current.change_set_sha256 !== request.expected_change_set_sha256 ||
      !equalStringArrays(currentPaths, expectedPaths)
    ) {
      throw new GitPublishError(
        "PUBLISH_CHANGE_SET_STALE",
        "The current worktree no longer matches the Phase 4 approved change set.",
      );
    }

    return current;
  }

  async publish(
    request: GitPublishRequest,
    previousReceipt: GitPublishReceipt | null = null,
  ): Promise<GitPublishReceipt> {
    assertRequest(request);
    const cwd = await this.assertCanonicalWorktree(request.worktree_path);
    const receipt = previousReceipt ?? initialReceipt(request, this.now);
    assertReceiptMatches(receipt, request);

    if (receipt.state === "PUSHED") {
      if (!receipt.commit_sha || !receipt.remote_branch_sha) {
        throw new GitPublishError(
          "PUBLISH_RECEIPT_INCONSISTENT",
          "A PUSHED receipt is missing its commit or remote branch SHA.",
        );
      }

      await this.assertRepositoryBoundary(request, cwd, receipt.commit_sha);
      const remoteSha = await this.readRemoteBranch(request, cwd);

      if (remoteSha !== receipt.commit_sha || remoteSha !== receipt.remote_branch_sha) {
        throw new GitPublishError(
          "PUBLISH_REMOTE_VERIFICATION_FAILED",
          "The pushed branch no longer points to the persisted commit.",
        );
      }

      return receipt;
    }

    if (receipt.state === "READY_FOR_COMMIT") {
      await this.assertRepositoryBoundary(request, cwd, request.base_commit);

      const existingRemoteSha = await this.readRemoteBranch(request, cwd);
      if (existingRemoteSha !== null) {
        throw new GitPublishError(
          "PUBLISH_REMOTE_BRANCH_EXISTS",
          "The delivery branch already exists remotely before the approved commit was created.",
          { remote_branch_sha: existingRemoteSha },
        );
      }

      await this.assertVerifiedChangeSet(request);
      const expectedPaths = normalizedPathSet(request.expected_paths);

      await requireSuccess(
        this.options.runner,
        ["--literal-pathspecs", "add", "-A", "--", ...expectedPaths],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The approved change paths could not be staged.",
      );

      const staged = await requireSuccess(
        this.options.runner,
        ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The staged change paths could not be inspected.",
      );

      if (!equalStringArrays(parseNulList(staged.stdout), expectedPaths)) {
        throw new GitPublishError(
          "PUBLISH_STAGE_MISMATCH",
          "The staged path set does not equal the Phase 4 approved path set.",
        );
      }

      const commit = await this.options.runner.run(
        ["commit", "--no-gpg-sign", "-m", request.commit_message],
        cwd,
      );

      if (commit.exitCode !== 0) {
        failCommand(
          "PUBLISH_COMMIT_FAILED",
          "Git could not create the approved product commit.",
          commit,
        );
      }

      const [commitShaResult, parentShaResult] = await Promise.all([
        requireSuccess(
          this.options.runner,
          ["rev-parse", "HEAD"],
          cwd,
          "PUBLISH_COMMIT_FAILED",
          "The created commit SHA could not be read.",
        ),
        requireSuccess(
          this.options.runner,
          ["rev-parse", "HEAD^"],
          cwd,
          "PUBLISH_COMMIT_FAILED",
          "The created commit parent could not be read.",
        ),
      ]);

      const commitSha = commitShaResult.stdout.trim();
      if (!GIT_OBJECT_ID.test(commitSha) || parentShaResult.stdout.trim() !== request.base_commit) {
        throw new GitPublishError(
          "PUBLISH_COMMIT_FAILED",
          "The created commit does not have the approved base commit as its single parent.",
        );
      }

      const timestamp = this.now().toISOString();
      receipt.state = "COMMITTED";
      receipt.commit_sha = commitSha;
      receipt.committed_at = timestamp;
      receipt.updated_at = timestamp;
      await this.options.persistReceipt(receipt);
    }

    if (receipt.state !== "COMMITTED" || !receipt.commit_sha) {
      throw new GitPublishError(
        "PUBLISH_RECEIPT_INCONSISTENT",
        "The publish operation did not reach a resumable COMMITTED state.",
      );
    }

    await this.assertRepositoryBoundary(request, cwd, receipt.commit_sha);
    const remoteBeforePush = await this.readRemoteBranch(request, cwd);

    if (remoteBeforePush !== null && remoteBeforePush !== receipt.commit_sha) {
      throw new GitPublishError(
        "PUBLISH_REMOTE_BRANCH_EXISTS",
        "The remote delivery branch exists at a different commit.",
        { remote_branch_sha: remoteBeforePush },
      );
    }

    if (remoteBeforePush === null) {
      const push = await this.options.runner.run(
        [
          "push",
          "--porcelain",
          request.remote_name,
          `${receipt.commit_sha}:refs/heads/${request.branch_name}`,
        ],
        cwd,
      );

      if (push.exitCode !== 0) {
        failCommand(
          "PUBLISH_PUSH_FAILED",
          "Git could not push the approved delivery branch.",
          push,
        );
      }
    }

    const remoteAfterPush = await this.readRemoteBranch(request, cwd);
    if (remoteAfterPush !== receipt.commit_sha) {
      throw new GitPublishError(
        "PUBLISH_REMOTE_VERIFICATION_FAILED",
        "The remote delivery branch does not point to the approved commit after push.",
      );
    }

    const timestamp = this.now().toISOString();
    receipt.state = "PUSHED";
    receipt.remote_branch_sha = remoteAfterPush;
    receipt.pushed_at = timestamp;
    receipt.updated_at = timestamp;
    await this.options.persistReceipt(receipt);

    return receipt;
  }
}
