import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ChangeSet } from "./contracts.js";
import { ExecutionError } from "./errors.js";
import { matches } from "./change-set.js";

export interface PathPolicyOptions {
  worktreePath: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  maximumChangedFiles: number;
  maximumDiffLines: number;
  allowedGeneratedPaths?: string[];
}

async function assertFilesystemObjects(options: PathPolicyOptions, changeSet: ChangeSet): Promise<void> {
  for (const entry of changeSet.entries) {
    const resolvedEntry = path.resolve(options.worktreePath, entry.path);
    if (resolvedEntry !== path.resolve(options.worktreePath) && !resolvedEntry.startsWith(`${path.resolve(options.worktreePath)}${path.sep}`)) throw new ExecutionError("PATH_POLICY_VIOLATION", `Changed path escapes worktree: ${entry.path}`);
    if (entry.mode === "160000") throw new ExecutionError("SUBMODULE_CHANGE_NOT_ALLOWED", `Submodule change is not allowed: ${entry.path}`);
    const target = path.join(options.worktreePath, entry.path);
    let ancestor = path.resolve(options.worktreePath);
    for (const segment of entry.path.split("/")) {
      ancestor = path.join(ancestor, segment);
      const ancestorInfo = await lstat(ancestor).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (ancestorInfo?.isSymbolicLink()) throw new ExecutionError("SYMLINK_CHANGE_NOT_ALLOWED", `Changed path has a symbolic-link ancestor: ${entry.path}`);
    }
    const info = await lstat(target).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new ExecutionError("SYMLINK_CHANGE_NOT_ALLOWED", `Changed path is a symbolic link: ${entry.path}`);
    if (!info.isFile() && !info.isDirectory()) throw new ExecutionError("SPECIAL_FILE_CHANGE_NOT_ALLOWED", `Changed path is a special file: ${entry.path}`);
    if (entry.path === ".git" || entry.path.startsWith(".git/") || entry.path === ".gitmodules" || entry.path.startsWith(".git/") || ["manifest.json", "acceptance.json", "test-matrix.json", "validation.json", "risk-policy.json", "checksums.json"].includes(entry.path)) throw new ExecutionError("FORBIDDEN_PATH_CHANGED", `Git metadata or execution contract path changed: ${entry.path}`);
  }
}

export async function enforcePathPolicy(options: PathPolicyOptions, changeSet: ChangeSet): Promise<void> {
  await assertFilesystemObjects(options, changeSet);
  if (changeSet.entries.length > options.maximumChangedFiles) throw new ExecutionError("CHANGE_LIMIT_EXCEEDED", "Changed-file limit exceeded.");
  if (changeSet.diff_lines > options.maximumDiffLines) throw new ExecutionError("CHANGE_LIMIT_EXCEEDED", "Diff-line limit exceeded.");
  for (const entry of changeSet.entries) {
    if (entry.binary) throw new ExecutionError("BINARY_CHANGE_NOT_ALLOWED", `Binary change is not allowed: ${entry.path}`);
    const generated = (options.allowedGeneratedPaths ?? []).some((pattern) => matches(pattern, entry.path));
    if (!generated && !options.allowedPaths.some((pattern) => matches(pattern, entry.path))) throw new ExecutionError("PATH_POLICY_VIOLATION", `Changed path is outside allowed paths: ${entry.path}`);
    if (options.forbiddenPaths.some((pattern) => matches(pattern, entry.path))) throw new ExecutionError("FORBIDDEN_PATH_CHANGED", `Changed path is forbidden: ${entry.path}`);
    if (entry.path === ".gitmodules" || entry.path.startsWith(".git/") || entry.path.startsWith(".git\\")) throw new ExecutionError("FORBIDDEN_PATH_CHANGED", `Git metadata path is forbidden: ${entry.path}`);
  }
}

export const checkPathPolicy = enforcePathPolicy;

export async function assertAgentIdentity(options: { worktreePath: string; baseCommit: string; branchName: string; head: string; branch: string }): Promise<void> {
  if (options.head !== options.baseCommit) throw new ExecutionError("AGENT_COMMITTED_CHANGES", "Agent changed HEAD or created a commit.");
  if (options.branch !== options.branchName) throw new ExecutionError("AGENT_CHANGED_BRANCH", "Agent changed the checked-out branch.");
}
