import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitRunner } from "../git/git-runner.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
import { RevisionError } from "./contracts.js";

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATHS = 2000;
type FileMode = "100644" | "100755";
interface SnapshotEntry { path: string; state: "file" | "deleted"; mode: FileMode | null; blob_oid: string | null; }

export interface RevisionGitBoundary { worktreePath: string; branchName: string; remoteName: string; remoteUrl: string; previousHeadSha: string; initialRefsSha256: string; }
export interface PublishRevisionRequest extends RevisionGitBoundary {
  approvedPaths: string[];
  approvedSnapshotSha256: string;
  commitMessage: string;
  onCommitted?: (commitSha: string, recoveredExistingCommit: boolean) => Promise<void>;
}
export interface PublishRevisionResult { previous_head_sha: string; new_commit_sha: string; remote_branch_sha: string; approved_snapshot_sha256: string; commit_tree_snapshot_sha256: string; paths: string[]; recovered_existing_commit: boolean; }

function output(result: Awaited<ReturnType<GitRunner["run"]>>, code: "REVISION_OPERATIONAL_ERROR" | "REVISION_COMMIT_FAILED" | "REVISION_PUSH_FAILED" = "REVISION_OPERATIONAL_ERROR"): string {
  if (result.exitCode !== 0) throw new RevisionError(code, result.stderr.trim() || result.stdout.trim() || `Git command failed: ${result.args.join(" ")}`);
  return result.stdout;
}
function normalizePath(value: string): string {
  if (!value || value.length > 4096 || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) throw new RevisionError("REVISION_POLICY_BLOCKED", `Unsafe revision path '${value}'.`);
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new RevisionError("REVISION_POLICY_BLOCKED", `Unsafe revision path '${value}'.`);
  return normalized;
}
function normalizePaths(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > MAX_PATHS) throw new RevisionError("REVISION_POLICY_BLOCKED", `Revision path count must be between 1 and ${MAX_PATHS}.`);
  const result = values.map(normalizePath).sort((a, b) => a.localeCompare(b));
  if (new Set(result).size !== result.length) throw new RevisionError("REVISION_POLICY_BLOCKED", "Revision paths must be unique.");
  return result;
}
function digestSnapshot(entries: readonly SnapshotEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path); hash.update("\0"); hash.update(entry.state); hash.update("\0"); hash.update(entry.mode ?? ""); hash.update("\0"); hash.update(entry.blob_oid ?? ""); hash.update("\0");
  }
  return hash.digest("hex");
}
function parseNul(value: string): string[] { return value.split("\0").filter(Boolean).map(normalizePath).sort((a, b) => a.localeCompare(b)); }
function equalArrays(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }

async function worktreeSnapshot(runner: GitRunner, worktree: string, paths: string[]): Promise<string> {
  const entries: SnapshotEntry[] = [];
  for (const relative of paths) {
    const target = path.join(worktree, relative);
    let stat: import("node:fs").Stats | undefined;
    try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!stat) { entries.push({ path: relative, state: "deleted", mode: null, blob_oid: null }); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new RevisionError("REVISION_POLICY_BLOCKED", `Revision path must be a regular non-symlink file: ${relative}`);
    const blob = output(await runner.run(["hash-object", "--no-filters", "--", relative], worktree)).trim();
    if (!GIT_OID.test(blob)) throw new RevisionError("REVISION_OPERATIONAL_ERROR", `Git returned invalid blob OID for '${relative}'.`);
    const tracked = await runner.run(["ls-files", "--stage", "--", relative], worktree);
    let mode: FileMode;
    if (tracked.exitCode === 0 && tracked.stdout.trim()) {
      const parsedMode = tracked.stdout.trim().split(/\s+/, 1)[0];
      if (parsedMode !== "100644" && parsedMode !== "100755") throw new RevisionError("REVISION_POLICY_BLOCKED", `Unsupported Git mode '${String(parsedMode)}' for '${relative}'.`);
      mode = parsedMode;
    } else mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    entries.push({ path: relative, state: "file", mode, blob_oid: blob });
  }
  return digestSnapshot(entries);
}
async function indexSnapshot(runner: GitRunner, worktree: string, paths: string[]): Promise<string> {
  const raw = output(await runner.run(["ls-files", "--stage", "-z", "--", ...paths], worktree));
  const byPath = new Map<string, { mode: FileMode; oid: string }>();
  for (const record of raw.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new RevisionError("REVISION_COMMIT_FAILED", "Malformed staged-index record.");
    const [mode, oid, stage] = record.slice(0, tab).split(/\s+/);
    const relative = normalizePath(record.slice(tab + 1));
    if (stage !== "0" || (mode !== "100644" && mode !== "100755") || !oid || !GIT_OID.test(oid)) throw new RevisionError("REVISION_COMMIT_FAILED", `Unsafe staged entry for '${relative}'.`);
    byPath.set(relative, { mode, oid });
  }
  return digestSnapshot(paths.map((relative) => { const item = byPath.get(relative); return item ? { path: relative, state: "file" as const, mode: item.mode, blob_oid: item.oid } : { path: relative, state: "deleted" as const, mode: null, blob_oid: null }; }));
}
async function commitSnapshot(runner: GitRunner, worktree: string, commit: string, paths: string[]): Promise<string> {
  const entries: SnapshotEntry[] = [];
  for (const relative of paths) {
    const raw = output(await runner.run(["ls-tree", "-z", commit, "--", relative], worktree));
    if (!raw) { entries.push({ path: relative, state: "deleted", mode: null, blob_oid: null }); continue; }
    const record = raw.split("\0").find(Boolean)!;
    const tab = record.indexOf("\t"); const [mode, type, oid] = record.slice(0, tab).split(/\s+/); const actualPath = normalizePath(record.slice(tab + 1));
    if (actualPath !== relative || type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid || !GIT_OID.test(oid)) throw new RevisionError("REVISION_COMMIT_FAILED", `Committed tree contains an unsafe entry for '${relative}'.`);
    entries.push({ path: relative, state: "file", mode, blob_oid: oid });
  }
  return digestSnapshot(entries);
}
async function remoteHead(runner: GitRunner, worktree: string, remote: string, branch: string): Promise<string> {
  const raw = output(await runner.run(["ls-remote", "--heads", remote, `refs/heads/${branch}`], worktree), "REVISION_PUSH_FAILED").trim();
  if (!raw) return "";
  const rows = raw.split(/\r?\n/).filter(Boolean); if (rows.length !== 1) throw new RevisionError("REVISION_REMOTE_DRIFT", `Remote branch '${branch}' resolved ambiguously.`);
  const [sha, ref] = rows[0]!.split(/\s+/); if (!sha || !GIT_OID.test(sha) || ref !== `refs/heads/${branch}`) throw new RevisionError("REVISION_REMOTE_DRIFT", `Remote branch '${branch}' returned malformed identity.`);
  return sha;
}
async function verifyCandidateCommit(runner: GitRunner, worktree: string, candidate: string, previous: string, paths: string[], approvedSnapshot: string): Promise<string> {
  if (!GIT_OID.test(candidate) || candidate === previous) throw new RevisionError("REVISION_COMMIT_FAILED", "Revision candidate commit is invalid.");
  const parentLine = output(await runner.run(["rev-list", "--parents", "-n", "1", candidate], worktree), "REVISION_COMMIT_FAILED").trim().split(/\s+/);
  if (parentLine.length !== 2 || parentLine[0] !== candidate || parentLine[1] !== previous) throw new RevisionError("REVISION_COMMIT_FAILED", "Revision commit must have exactly previous_pr_head_sha as its single parent.");
  const commitPaths = parseNul(output(await runner.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", candidate], worktree), "REVISION_COMMIT_FAILED"));
  if (!equalArrays(commitPaths, paths)) throw new RevisionError("REVISION_COMMIT_FAILED", "Committed path set does not match the approved revision path set.");
  const treeSnapshot = await commitSnapshot(runner, worktree, candidate, paths); if (treeSnapshot !== approvedSnapshot) throw new RevisionError("REVISION_COMMIT_FAILED", "Committed tree does not match the approved revision snapshot.");
  return treeSnapshot;
}

export async function attestRevisionGitBoundary(params: { worktreePath: string; branchName: string; remoteName: string; expectedRemoteUrls: string[]; previousHeadSha: string; runner?: GitRunner }): Promise<RevisionGitBoundary> {
  const runner = params.runner ?? new GitRunner(); if (!GIT_OID.test(params.previousHeadSha)) throw new RevisionError("REVISION_HEAD_DRIFT", "Previous head SHA is invalid."); if (!SAFE_REMOTE.test(params.remoteName)) throw new RevisionError("REVISION_CONFIG_INVALID", `Unsafe remote name '${params.remoteName}'.`);
  const requested = path.resolve(params.worktreePath); const canonical = await realpath(requested).catch((error) => { throw new RevisionError("REVISION_WORKTREE_UNSAFE", `Cannot resolve revision worktree: ${error instanceof Error ? error.message : String(error)}`); });
  if (canonical !== requested) throw new RevisionError("REVISION_WORKTREE_UNSAFE", "Revision worktree path is not canonical."); const stat = await lstat(canonical); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RevisionError("REVISION_WORKTREE_UNSAFE", "Revision worktree must be a real directory.");
  const head = output(await runner.run(["rev-parse", "HEAD"], canonical)).trim(); const branch = output(await runner.run(["branch", "--show-current"], canonical)).trim();
  if (head !== params.previousHeadSha) throw new RevisionError("REVISION_HEAD_DRIFT", `Local HEAD '${head}' does not match previous PR head '${params.previousHeadSha}'.`); if (branch !== params.branchName) throw new RevisionError("REVISION_BRANCH_DRIFT", `Local branch '${branch}' does not match '${params.branchName}'.`);
  if (output(await runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], canonical)).length !== 0) throw new RevisionError("REVISION_WORKTREE_DIRTY", "Revision worktree must be clean before a revision round starts.");
  const remoteUrl = output(await runner.run(["remote", "get-url", params.remoteName], canonical)).trim(); let sanitized: string; try { sanitized = sanitizeRemoteUrl(remoteUrl); } catch (error) { throw new RevisionError("REVISION_REMOTE_DRIFT", `Revision remote URL is unsafe: ${error instanceof Error ? error.message : String(error)}`); }
  if (!params.expectedRemoteUrls.map((value) => sanitizeRemoteUrl(value)).includes(sanitized)) throw new RevisionError("REVISION_REMOTE_DRIFT", "Revision remote URL is not present in the trusted repository registry.");
  const remoteSha = await remoteHead(runner, canonical, params.remoteName, params.branchName); if (remoteSha !== params.previousHeadSha) throw new RevisionError("REVISION_REMOTE_DRIFT", `Remote branch is '${remoteSha || "<missing>"}', expected '${params.previousHeadSha}'.`);
  return { worktreePath: canonical, branchName: params.branchName, remoteName: params.remoteName, remoteUrl, previousHeadSha: params.previousHeadSha, initialRefsSha256: "" };
}
export async function calculateApprovedRevisionSnapshot(params: { runner?: GitRunner; worktreePath: string; approvedPaths: string[] }): Promise<string> { return worktreeSnapshot(params.runner ?? new GitRunner(), path.resolve(params.worktreePath), normalizePaths(params.approvedPaths)); }

export async function publishRevision(request: PublishRevisionRequest, runner = new GitRunner()): Promise<PublishRevisionResult> {
  const worktree = path.resolve(request.worktreePath); const paths = normalizePaths(request.approvedPaths);
  if (!GIT_OID.test(request.previousHeadSha)) throw new RevisionError("REVISION_HEAD_DRIFT", "Previous head SHA is invalid."); if (!/^[a-f0-9]{64}$/.test(request.approvedSnapshotSha256)) throw new RevisionError("REVISION_COMMIT_FAILED", "Approved snapshot SHA is invalid."); if (!request.commitMessage || request.commitMessage.length > 4096 || request.commitMessage.includes("\0")) throw new RevisionError("REVISION_COMMIT_FAILED", "Revision commit message is invalid.");
  const branch = output(await runner.run(["branch", "--show-current"], worktree)).trim(); if (branch !== request.branchName) throw new RevisionError("REVISION_BRANCH_DRIFT", `Revision publish branch '${branch}' does not match '${request.branchName}'.`);
  const head = output(await runner.run(["rev-parse", "HEAD"], worktree)).trim(); let newCommit: string; let treeSnapshot: string; let recovered = false;
  if (head === request.previousHeadSha) {
    if (await remoteHead(runner, worktree, request.remoteName, request.branchName) !== request.previousHeadSha) throw new RevisionError("REVISION_REMOTE_DRIFT", "Remote branch drifted before revision commit/push.");
    if (await worktreeSnapshot(runner, worktree, paths) !== request.approvedSnapshotSha256) throw new RevisionError("REVISION_COMMIT_FAILED", "Worktree bytes no longer match the approved revision snapshot.");
    output(await runner.run(["--literal-pathspecs", "add", "-A", "--", ...paths], worktree), "REVISION_COMMIT_FAILED");
    const stagedPaths = parseNul(output(await runner.run(["diff", "--cached", "--name-only", "-z", request.previousHeadSha, "--"], worktree), "REVISION_COMMIT_FAILED")); if (!equalArrays(stagedPaths, paths)) throw new RevisionError("REVISION_COMMIT_FAILED", "Staged path set does not match the approved revision path set.");
    if (await indexSnapshot(runner, worktree, paths) !== request.approvedSnapshotSha256) throw new RevisionError("REVISION_COMMIT_FAILED", "Staged index does not match the approved revision snapshot.");
    output(await runner.run(["commit", "--no-verify", "--no-gpg-sign", "-m", request.commitMessage], worktree), "REVISION_COMMIT_FAILED"); newCommit = output(await runner.run(["rev-parse", "HEAD"], worktree), "REVISION_COMMIT_FAILED").trim(); treeSnapshot = await verifyCandidateCommit(runner, worktree, newCommit, request.previousHeadSha, paths, request.approvedSnapshotSha256);
  } else {
    newCommit = head; treeSnapshot = await verifyCandidateCommit(runner, worktree, newCommit, request.previousHeadSha, paths, request.approvedSnapshotSha256);
    if (output(await runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree)).length !== 0) throw new RevisionError("REVISION_COMMIT_FAILED", "Recovered revision commit has additional uncommitted changes."); recovered = true;
  }

  if (request.onCommitted) await request.onCommitted(newCommit, recovered);

  const remoteNow = await remoteHead(runner, worktree, request.remoteName, request.branchName);
  if (remoteNow === newCommit) return { previous_head_sha: request.previousHeadSha, new_commit_sha: newCommit, remote_branch_sha: remoteNow, approved_snapshot_sha256: request.approvedSnapshotSha256, commit_tree_snapshot_sha256: treeSnapshot, paths, recovered_existing_commit: true };
  if (remoteNow !== request.previousHeadSha) throw new RevisionError("REVISION_REMOTE_DRIFT", "Remote branch is neither previous head nor the exact recovered revision commit.");
  output(await runner.run(["push", request.remoteName, `${request.branchName}:refs/heads/${request.branchName}`], worktree), "REVISION_PUSH_FAILED"); const remoteAfter = await remoteHead(runner, worktree, request.remoteName, request.branchName); if (remoteAfter !== newCommit) throw new RevisionError("REVISION_PUSH_FAILED", `Remote branch did not attest the new revision commit '${newCommit}'.`);
  if (output(await runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree)).length !== 0) throw new RevisionError("REVISION_COMMIT_FAILED", "Revision worktree is not clean after the append-only commit.");
  return { previous_head_sha: request.previousHeadSha, new_commit_sha: newCommit, remote_branch_sha: remoteAfter, approved_snapshot_sha256: request.approvedSnapshotSha256, commit_tree_snapshot_sha256: treeSnapshot, paths, recovered_existing_commit: recovered };
}
