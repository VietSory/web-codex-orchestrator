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

function failCommand(
  code: CommandFailureCode,
  message: string,
  result: GitCommandResult,
): never {
  throw new GitPublishError(code, message, {
    exit_code: result.exitCode,
    signal: result.signal ?? null,
    stderr_tail: bounded(result.stderr.slice(-4_096)),
  });
}

function normalizeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw new GitPublishError(
      "PUBLISH_REQUEST_INVALID",
      "Publish paths must be bounded relative NUL-free paths.",
    );
  }

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
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

function equalStringArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseNulList(value: string): string[] {
  if (value.length === 0) return [];
  return value
    .split("\u0000")
    .filter((entry) => entry.length > 0)
    .map(normalizeRelativePath)
    .sort((left, right) => left.localeCompare(right));
}

function snapshotDigest(entries: readonly SnapshotEntry[]): string {
  const digest = createHash("sha256");

  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update(entry.path);
    digest.update("\u0000");
    digest.update(entry.state);
    digest.update("\u0000");
    digest.update(entry.mode ?? "");
    digest.update("\u0000");
    digest.update(entry.blobOid ?? "");
    digest.update("\u0000");
  }

  return digest.digest("hex");
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

  if (
    !path.isAbsolute(request.worktree_path) ||
    request.worktree_path.includes("\u0000")
  ) {
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
    request.branch_name.length > 1_024 ||
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
    request.allowed_remote_url.length > 8_192 ||
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
  approvedSnapshotSha256: string,
  now: () => Date,
): GitPublishReceipt {
  const timestamp = now().toISOString();

  return {
    publish_version: "1.1",
    run_id: request.run_id,
    state: "READY_FOR_COMMIT",
    base_commit: request.base_commit,
    branch_name: request.branch_name,
    remote_name: request.remote_name,
    allowed_remote_url: request.allowed_remote_url,
    change_set_sha256: request.expected_change_set_sha256,
    expected_paths: normalizedPathSet(request.expected_paths),
    approved_snapshot_sha256: approvedSnapshotSha256,
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
  const expectedPaths = normalizedPathSet(request.expected_paths);

  if (
    receipt.publish_version !== "1.1" ||
    receipt.run_id !== request.run_id ||
    receipt.base_commit !== request.base_commit ||
    receipt.branch_name !== request.branch_name ||
    receipt.remote_name !== request.remote_name ||
    receipt.allowed_remote_url !== request.allowed_remote_url ||
    receipt.change_set_sha256 !== request.expected_change_set_sha256 ||
    !equalStringArrays(receipt.expected_paths, expectedPaths) ||
    !SHA256.test(receipt.approved_snapshot_sha256)
  ) {
    throw new GitPublishError(
      "PUBLISH_RECEIPT_INCONSISTENT",
      "The persisted publish receipt does not match the current request.",
    );
  }
}

async function requireSuccess(
  runner: GitPublisherOptions["runner"],
  args: readonly string[],
  cwd: string,
  code: CommandFailureCode,
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

  private async readRepositoryBoundary(
    request: GitPublishRequest,
    cwd: string,
  ): Promise<RepositoryBoundary> {
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

    const boundary = {
      head: head.stdout.trim(),
      branch: branch.stdout.trim(),
      remoteUrl: remoteUrl.stdout.trim(),
    };

    if (!GIT_OBJECT_ID.test(boundary.head)) {
      throw new GitPublishError(
        "PUBLISH_BASE_MISMATCH",
        "The worktree HEAD is not a full Git object ID.",
      );
    }

    if (boundary.branch !== request.branch_name) {
      throw new GitPublishError(
        "PUBLISH_BRANCH_POLICY_VIOLATION",
        "The current worktree branch does not match the approved delivery branch.",
      );
    }

    if (boundary.remoteUrl !== request.allowed_remote_url) {
      throw new GitPublishError(
        "PUBLISH_REMOTE_MISMATCH",
        "The configured push URL does not match the trusted delivery remote.",
      );
    }

    return boundary;
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

  private async preflightRemoteBranchCreation(
    request: GitPublishRequest,
    cwd: string,
  ): Promise<void> {
    const preflight = await this.options.runner.run(
      [
        "push",
        "--dry-run",
        "--porcelain",
        "--force-with-lease=refs/heads/" + request.branch_name + ":",
        request.remote_name,
        request.base_commit + ":refs/heads/" + request.branch_name,
      ],
      cwd,
    );

    if (preflight.exitCode !== 0) {
      const recheckRemoteSha = await this.readRemoteBranch(request, cwd);
      if (recheckRemoteSha !== null) {
        throw new GitPublishError(
          "PUBLISH_REMOTE_BRANCH_EXISTS",
          "The delivery branch was created remotely during preflight.",
          { remote_branch_sha: recheckRemoteSha },
        );
      }
      
      const stderr = preflight.stderr.toLowerCase();
      if (stderr.includes("403") || stderr.includes("authentication failed") || stderr.includes("could not read username") || stderr.includes("could not read password")) {
        throw new GitPublishError("PUBLISH_AUTH_FAILED", "Authentication failed during push preflight.");
      }

      failCommand(
        "PUBLISH_PUSH_PREFLIGHT_FAILED",
        "Git push preflight failed.",
        preflight,
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

  private async honorsFilesystemExecutableBit(
    cwd: string,
  ): Promise<boolean> {
    const result = await this.options.runner.run(
      ["config", "--bool", "--get", "core.fileMode"],
      cwd,
    );

    /*
     * An unset value uses Git's normal default behavior. Treat it as true.
     * A normal repository created or cloned by Git normally has this value.
     */
    if (
      result.exitCode === 1 &&
      result.stdout.trim().length === 0 &&
      result.stderr.trim().length === 0
    ) {
      return true;
    }

    if (result.exitCode !== 0) {
      failCommand(
        "PUBLISH_COMMIT_FAILED",
        "The repository file-mode policy could not be read.",
        result,
      );
    }

    const value = result.stdout.trim().toLowerCase();

    if (value === "true") return true;
    if (value === "false") return false;

    throw new GitPublishError(
      "PUBLISH_COMMIT_FAILED",
      "The repository returned an invalid core.fileMode value.",
    );
  }

  private async existingIndexMode(
    cwd: string,
    relativePath: string,
  ): Promise<RegularFileMode | null> {
    const listed = await requireSuccess(
      this.options.runner,
      [
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-z",
        "--",
        relativePath,
      ],
      cwd,
      "PUBLISH_COMMIT_FAILED",
      "The existing Git index mode could not be inspected.",
    );

    const records = listed.stdout
      .split("\u0000")
      .filter((entry) => entry.length > 0);

    if (records.length === 0) {
      return null;
    }

    if (records.length !== 1) {
      throw new GitPublishError(
        "PUBLISH_INDEX_MISMATCH",
        "The Git index contains multiple entries for one approved path.",
        { path: relativePath },
      );
    }

    const match =
      /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(
        records[0]!,
      );

    if (!match) {
      throw new GitPublishError(
        "PUBLISH_INDEX_MISMATCH",
        "The Git index returned an unparseable mode record.",
        { path: relativePath },
      );
    }

    const [, mode, blobOid, stage, rawPath] = match;
    const normalizedPath = normalizeRelativePath(rawPath!);

    if (
      normalizedPath !== relativePath ||
      stage !== "0" ||
      (mode !== "100644" && mode !== "100755") ||
      !GIT_OBJECT_ID.test(blobOid!)
    ) {
      throw new GitPublishError(
        "PUBLISH_INDEX_MISMATCH",
        "The Git index returned an unsupported mode record.",
        { path: relativePath },
      );
    }

    return mode as RegularFileMode;
  }

  private async workingTreeSnapshot(
    cwd: string,
    expectedPaths: readonly string[],
  ): Promise<string> {
    const entries: SnapshotEntry[] = [];
    const honorsExecutableBit =
      await this.honorsFilesystemExecutableBit(cwd);

    for (const relativePath of expectedPaths) {
      const absolutePath = path.join(cwd, ...relativePath.split("/"));
      let info;

      try {
        info = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          entries.push({
            path: relativePath,
            state: "deleted",
            mode: null,
            blobOid: null,
          });
          continue;
        }

        throw new GitPublishError(
          "PUBLISH_CHANGE_SET_STALE",
          "An approved worktree path could not be inspected.",
        );
      }

      if (info.isSymbolicLink() || !info.isFile()) {
        throw new GitPublishError(
          "PUBLISH_CHANGE_SET_STALE",
          "Approved publish paths must resolve to regular files or deletions.",
          { path: relativePath },
        );
      }

      const hashed = await requireSuccess(
        this.options.runner,
        ["hash-object", `--path=${relativePath}`, "--", relativePath],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "An approved worktree file could not be hashed by Git.",
      );
      const blobOid = hashed.stdout.trim();

      if (!GIT_OBJECT_ID.test(blobOid)) {
        throw new GitPublishError(
          "PUBLISH_CHANGE_SET_STALE",
          "Git returned an invalid worktree blob object ID.",
          { path: relativePath },
        );
      }

      let projectedMode: RegularFileMode;

      if (honorsExecutableBit) {
        projectedMode =
          (info.mode & 0o111) === 0 ? "100644" : "100755";
      } else {
        projectedMode =
          (await this.existingIndexMode(
            cwd,
            relativePath,
          )) ?? "100644";
      }

      entries.push({
        path: relativePath,
        state: "file",
        mode: projectedMode,
        blobOid: blobOid!,
      });
    }

    return snapshotDigest(entries);
  }

  private async stagedPaths(cwd: string): Promise<string[]> {
    const staged = await requireSuccess(
      this.options.runner,
      [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRTUXB",
      ],
      cwd,
      "PUBLISH_COMMIT_FAILED",
      "The staged change paths could not be inspected.",
    );

    return parseNulList(staged.stdout);
  }

  private async indexSnapshot(
    cwd: string,
    expectedPaths: readonly string[],
  ): Promise<string> {
    const listed = await requireSuccess(
      this.options.runner,
      [
        "--literal-pathspecs",
        "ls-files",
        "--stage",
        "-z",
        "--",
        ...expectedPaths,
      ],
      cwd,
      "PUBLISH_COMMIT_FAILED",
      "The staged index entries could not be inspected.",
    );

    const records = new Map<string, SnapshotEntry>();

    for (const rawRecord of listed.stdout.split("\u0000").filter(Boolean)) {
      const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(
        rawRecord,
      );

      if (!match) {
        throw new GitPublishError(
          "PUBLISH_INDEX_MISMATCH",
          "The Git index returned an unparseable stage record.",
        );
      }

      const [, mode, blobOid, stage, rawPath] = match;
      const relativePath = normalizeRelativePath(rawPath!);

      if (
        stage !== "0" ||
        (mode !== "100644" && mode !== "100755") ||
        !GIT_OBJECT_ID.test(blobOid!) ||
        records.has(relativePath)
      ) {
        throw new GitPublishError(
          "PUBLISH_INDEX_MISMATCH",
          "The Git index contains an unsupported or conflicting entry.",
          { path: relativePath },
        );
      }

      records.set(relativePath, {
        path: relativePath,
        state: "file",
        mode,
        blobOid: blobOid!,
      });
    }

    return snapshotDigest(
      expectedPaths.map(
        (relativePath): SnapshotEntry =>
          records.get(relativePath) ?? {
            path: relativePath,
            state: "deleted",
            mode: null,
            blobOid: null,
          },
      ),
    );
  }

  private async commitSnapshot(
    cwd: string,
    commitSha: string,
    expectedPaths: readonly string[],
  ): Promise<string> {
    const listed = await requireSuccess(
      this.options.runner,
      [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commitSha,
        "--",
        ...expectedPaths,
      ],
      cwd,
      "PUBLISH_COMMIT_FAILED",
      "The created commit tree could not be inspected.",
    );

    const records = new Map<string, SnapshotEntry>();

    for (const rawRecord of listed.stdout.split("\u0000").filter(Boolean)) {
      const match = /^(\d{6}) ([^ ]+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(
        rawRecord,
      );

      if (!match) {
        throw new GitPublishError(
          "PUBLISH_COMMIT_MISMATCH",
          "The created commit returned an unparseable tree record.",
        );
      }

      const [, mode, objectType, blobOid, rawPath] = match;
      const relativePath = normalizeRelativePath(rawPath!);

      if (
        objectType !== "blob" ||
        (mode !== "100644" && mode !== "100755") ||
        !GIT_OBJECT_ID.test(blobOid!) ||
        records.has(relativePath)
      ) {
        throw new GitPublishError(
          "PUBLISH_COMMIT_MISMATCH",
          "The created commit contains an unsupported publish entry.",
          { path: relativePath },
        );
      }

      records.set(relativePath, {
        path: relativePath,
        state: "file",
        mode,
        blobOid: blobOid!,
      });
    }

    return snapshotDigest(
      expectedPaths.map(
        (relativePath): SnapshotEntry =>
          records.get(relativePath) ?? {
            path: relativePath,
            state: "deleted",
            mode: null,
            blobOid: null,
          },
      ),
    );
  }

  private async attestCurrentWorktree(
    request: GitPublishRequest,
    cwd: string,
  ): Promise<string> {
    const expectedPaths = normalizedPathSet(request.expected_paths);

    await this.assertVerifiedChangeSet(request);
    const firstSnapshot = await this.workingTreeSnapshot(cwd, expectedPaths);
    await this.assertVerifiedChangeSet(request);
    const secondSnapshot = await this.workingTreeSnapshot(cwd, expectedPaths);

    if (firstSnapshot !== secondSnapshot) {
      throw new GitPublishError(
        "PUBLISH_CHANGE_SET_STALE",
        "The approved worktree changed while the publish boundary was being attested.",
      );
    }

    return firstSnapshot;
  }

  private async assertCommitAttestation(
    request: GitPublishRequest,
    receipt: GitPublishReceipt,
    cwd: string,
    commitSha: string,
  ): Promise<void> {
    const expectedPaths = normalizedPathSet(request.expected_paths);
    const [parents, changedPaths, message] = await Promise.all([
      requireSuccess(
        this.options.runner,
        ["rev-list", "--parents", "-n", "1", commitSha],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The created commit parents could not be inspected.",
      ),
      requireSuccess(
        this.options.runner,
        [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          request.base_commit,
          commitSha,
          "--",
        ],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The created commit paths could not be inspected.",
      ),
      requireSuccess(
        this.options.runner,
        ["log", "-1", "--format=%B", commitSha],
        cwd,
        "PUBLISH_COMMIT_FAILED",
        "The created commit message could not be inspected.",
      ),
    ]);

    const parentTokens = parents.stdout.trim().split(/\s+/);
    if (
      parentTokens.length !== 2 ||
      parentTokens[0] !== commitSha ||
      parentTokens[1] !== request.base_commit
    ) {
      throw new GitPublishError(
        "PUBLISH_COMMIT_MISMATCH",
        "The product commit must have exactly the approved base commit as its parent.",
      );
    }

    if (!equalStringArrays(parseNulList(changedPaths.stdout), expectedPaths)) {
      throw new GitPublishError(
        "PUBLISH_COMMIT_MISMATCH",
        "The created commit path set differs from the approved path set.",
      );
    }

    if (message.stdout.trimEnd() !== request.commit_message.trimEnd()) {
      throw new GitPublishError(
        "PUBLISH_COMMIT_MISMATCH",
        "The created commit message differs from the approved message.",
      );
    }

    const committedSnapshot = await this.commitSnapshot(
      cwd,
      commitSha,
      expectedPaths,
    );

    if (committedSnapshot !== receipt.approved_snapshot_sha256) {
      throw new GitPublishError(
        "PUBLISH_COMMIT_MISMATCH",
        "The created commit tree differs from the pre-commit approved snapshot.",
      );
    }
  }

  private async recoverCommittedReceipt(
    request: GitPublishRequest,
    receipt: GitPublishReceipt,
    cwd: string,
    head: string,
  ): Promise<void> {
    try {
      await this.assertCommitAttestation(request, receipt, cwd, head);
    } catch (error) {
      if (error instanceof GitPublishError) {
        throw new GitPublishError(
          "PUBLISH_RECOVERY_FAILED",
          "A commit exists without a COMMITTED receipt, but it does not match the approved snapshot.",
          { cause_code: error.code },
        );
      }

      throw error;
    }

    const timestamp = this.now().toISOString();
    receipt.state = "COMMITTED";
    receipt.commit_sha = head;
    receipt.committed_at = timestamp;
    receipt.updated_at = timestamp;
    await this.options.persistReceipt(receipt);
  }

  async publish(
    request: GitPublishRequest,
    previousReceipt: GitPublishReceipt | null = null,
  ): Promise<GitPublishReceipt> {
    assertRequest(request);
    const cwd = await this.assertCanonicalWorktree(request.worktree_path);
    const expectedPaths = normalizedPathSet(request.expected_paths);
    let receipt = previousReceipt;
    let boundary = await this.readRepositoryBoundary(request, cwd);

    if (receipt !== null) {
      assertReceiptMatches(receipt, request);
    }

    if (receipt?.state === "PUSHED") {
      if (!receipt.commit_sha || !receipt.remote_branch_sha) {
        throw new GitPublishError(
          "PUBLISH_RECEIPT_INCONSISTENT",
          "A PUSHED receipt is missing its commit or remote branch SHA.",
        );
      }

      if (boundary.head !== receipt.commit_sha) {
        throw new GitPublishError(
          "PUBLISH_BASE_MISMATCH",
          "The worktree HEAD no longer equals the persisted product commit.",
        );
      }

      await this.assertCommitAttestation(
        request,
        receipt,
        cwd,
        receipt.commit_sha,
      );
      const remoteSha = await this.readRemoteBranch(request, cwd);

      if (
        remoteSha !== receipt.commit_sha ||
        remoteSha !== receipt.remote_branch_sha
      ) {
        throw new GitPublishError(
          "PUBLISH_REMOTE_VERIFICATION_FAILED",
          "The pushed branch no longer points to the persisted commit.",
        );
      }

      return receipt;
    }

    if (receipt === null) {
      if (boundary.head !== request.base_commit) {
        throw new GitPublishError(
          "PUBLISH_BASE_MISMATCH",
          "The first publish attempt must start at the exact approved base commit.",
        );
      }

      const existingRemoteSha = await this.readRemoteBranch(request, cwd);
      if (existingRemoteSha !== null) {
        throw new GitPublishError(
          "PUBLISH_REMOTE_BRANCH_EXISTS",
          "The delivery branch already exists remotely before a publish intent was persisted.",
          { remote_branch_sha: existingRemoteSha },
        );
      }

      const approvedSnapshot = await this.attestCurrentWorktree(request, cwd);
      receipt = initialReceipt(request, approvedSnapshot, this.now);

      // The durable READY receipt is written before staging or commit. This is
      // the recovery anchor for a crash after Git creates the commit.
      await this.options.persistReceipt(receipt);
    }

    if (receipt.state === "READY_FOR_COMMIT") {
      if (boundary.head !== request.base_commit) {
        await this.recoverCommittedReceipt(
          request,
          receipt,
          cwd,
          boundary.head,
        );
      } else {
        const existingRemoteSha = await this.readRemoteBranch(request, cwd);
        if (existingRemoteSha !== null) {
          throw new GitPublishError(
            "PUBLISH_REMOTE_BRANCH_EXISTS",
            "The delivery branch already exists remotely before the approved commit was created.",
            { remote_branch_sha: existingRemoteSha },
          );
        }

        let stagedPaths = await this.stagedPaths(cwd);

        if (stagedPaths.length === 0) {
          const approvedSnapshot = await this.attestCurrentWorktree(request, cwd);
          if (approvedSnapshot !== receipt.approved_snapshot_sha256) {
            throw new GitPublishError(
              "PUBLISH_CHANGE_SET_STALE",
              "The current approved worktree snapshot differs from the persisted publish intent.",
            );
          }

          await this.preflightRemoteBranchCreation(request, cwd);

          await requireSuccess(
            this.options.runner,
            ["--literal-pathspecs", "add", "-A", "--", ...expectedPaths],
            cwd,
            "PUBLISH_COMMIT_FAILED",
            "The approved change paths could not be staged.",
          );

          stagedPaths = await this.stagedPaths(cwd);
          
          if (!equalStringArrays(stagedPaths, expectedPaths)) {
            throw new GitPublishError(
              "PUBLISH_STAGE_MISMATCH",
              "The staged path set does not equal the Phase 4 approved path set.",
            );
          }
  
          const stagedSnapshot = await this.indexSnapshot(cwd, expectedPaths);
          if (stagedSnapshot !== receipt.approved_snapshot_sha256) {
            throw new GitPublishError(
              "PUBLISH_INDEX_MISMATCH",
              "The staged index content differs from the approved pre-stage snapshot.",
            );
          }
        } else {
          if (!equalStringArrays(stagedPaths, expectedPaths)) {
            throw new GitPublishError(
              "PUBLISH_STAGE_MISMATCH",
              "The staged path set does not equal the Phase 4 approved path set.",
            );
          }
  
          const stagedSnapshot = await this.indexSnapshot(cwd, expectedPaths);
          if (stagedSnapshot !== receipt.approved_snapshot_sha256) {
            throw new GitPublishError(
              "PUBLISH_INDEX_MISMATCH",
              "The staged index content differs from the approved pre-stage snapshot.",
            );
          }

          await this.preflightRemoteBranchCreation(request, cwd);
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

        const commitShaResult = await requireSuccess(
          this.options.runner,
          ["rev-parse", "HEAD"],
          cwd,
          "PUBLISH_COMMIT_FAILED",
          "The created commit SHA could not be read.",
        );
        const commitSha = commitShaResult.stdout.trim();

        if (!GIT_OBJECT_ID.test(commitSha)) {
          throw new GitPublishError(
            "PUBLISH_COMMIT_FAILED",
            "Git returned an invalid product commit SHA.",
          );
        }

        await this.assertCommitAttestation(
          request,
          receipt,
          cwd,
          commitSha,
        );

        const timestamp = this.now().toISOString();
        receipt.state = "COMMITTED";
        receipt.commit_sha = commitSha;
        receipt.committed_at = timestamp;
        receipt.updated_at = timestamp;
        await this.options.persistReceipt(receipt);
      }
    }

    if (receipt.state !== "COMMITTED" || !receipt.commit_sha) {
      throw new GitPublishError(
        "PUBLISH_RECEIPT_INCONSISTENT",
        "The publish operation did not reach a resumable COMMITTED state.",
      );
    }

    boundary = await this.readRepositoryBoundary(request, cwd);
    if (boundary.head !== receipt.commit_sha) {
      throw new GitPublishError(
        "PUBLISH_BASE_MISMATCH",
        "The worktree HEAD differs from the persisted product commit.",
      );
    }

    await this.assertCommitAttestation(
      request,
      receipt,
      cwd,
      receipt.commit_sha,
    );

    const remoteBeforePush = await this.readRemoteBranch(request, cwd);

    if (
      remoteBeforePush !== null &&
      remoteBeforePush !== receipt.commit_sha
    ) {
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
          "--force-with-lease=refs/heads/" + request.branch_name + ":",
          request.remote_name,
          receipt.commit_sha + ":refs/heads/" + request.branch_name,
        ],
        cwd,
      );

      if (push.exitCode !== 0) {
        const recheckRemoteSha = await this.readRemoteBranch(request, cwd);
        
        if (recheckRemoteSha === receipt.commit_sha) {
          // It actually succeeded before failing on the client side (e.g. connection drop)
        } else if (recheckRemoteSha !== null) {
          throw new GitPublishError(
            "PUBLISH_REMOTE_BRANCH_EXISTS",
            "The remote delivery branch was created by a racing process.",
            { remote_branch_sha: recheckRemoteSha },
          );
        } else {
          const stderr = push.stderr.toLowerCase();
          if (stderr.includes("403") || stderr.includes("authentication failed") || stderr.includes("could not read username") || stderr.includes("could not read password")) {
            throw new GitPublishError("PUBLISH_AUTH_FAILED", "Authentication failed during push.");
          }

          failCommand(
            "PUBLISH_PUSH_FAILED",
            "Git could not push the approved delivery branch.",
            push,
          );
        }
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
