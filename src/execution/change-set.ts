import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { GitCommandResult } from "../git/contracts.js";
import { GitRunner } from "../git/git-runner.js";
import type { ChangeEntry, ChangeSet } from "./contracts.js";
import { ExecutionError } from "./errors.js";

function resultOrThrow(result: GitCommandResult, code: "OPERATIONAL_ERROR" = "OPERATIONAL_ERROR"): string {
  if (result.exitCode !== 0) throw new ExecutionError(code, result.stderr.trim() || result.stdout.trim() || "Git command failed.");
  return result.stdout;
}

async function allFiles(root: string, current = root, result: string[] = []): Promise<string[]> {
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, entry.name);
    const info = await lstat(full);
    if (info.isDirectory() && !info.isSymbolicLink()) await allFiles(root, full, result);
    else if (info.isFile() || info.isSymbolicLink()) result.push(path.relative(root, full).replaceAll(path.sep, "/"));
  }
  return result;
}

function parseStatus(output: string): Array<{ type: string; path: string; oldPath?: string }> {
  const result: Array<{ type: string; path: string; oldPath?: string }> = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]; if (!field) continue;
    const code = field.slice(0, 2); const rawPath = field.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      const next = fields[++i] ?? "";
      result.push({ type: "renamed", path: next.replaceAll("\\", "/"), oldPath: rawPath.replaceAll("\\", "/") });
    } else {
      const type = code.includes("D") ? "deleted" : code.includes("A") || code === "??" ? "added" : "modified";
      result.push({ type, path: rawPath.replaceAll("\\", "/") });
    }
  }
  return result;
}

async function contentHash(worktree: string, relative: string, type: string): Promise<string | null> {
  if (type === "deleted") return null;
  const target = path.join(worktree, relative);
  const info = await lstat(target);
  if (info.isSymbolicLink()) return createHash("sha256").update(await readFile(target)).digest("hex");
  if (!info.isFile()) return null;
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

export async function calculateChangeSet(options: { worktreePath: string; baseCommit: string; branchName: string; runner?: GitRunner | undefined; allowedGeneratedPaths?: string[] | undefined }): Promise<ChangeSet> {
  const runner = options.runner ?? new GitRunner();
  const worktree = path.resolve(options.worktreePath);
  const head = resultOrThrow(await runner.run(["rev-parse", "HEAD"], worktree)).trim();
  const branch = resultOrThrow(await runner.run(["branch", "--show-current"], worktree)).trim();
  if (head !== options.baseCommit) throw new ExecutionError("AGENT_COMMITTED_CHANGES", "Worktree HEAD no longer matches the base commit.");
  if (branch !== options.branchName) throw new ExecutionError("AGENT_CHANGED_BRANCH", "Worktree branch no longer matches the preparation receipt.");
  const status = parseStatus(resultOrThrow(await runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree)));
  const entries: ChangeEntry[] = [];
  for (const item of status.sort((a, b) => a.path.localeCompare(b.path))) {
    const target = path.join(worktree, item.path);
    let mode = "000000"; let binary = false;
    try { const info = await lstat(target); mode = (info.mode & 0o7777).toString(8).padStart(6, "0"); binary = !info.isFile() && !info.isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const hash = await contentHash(worktree, item.path, item.type);
    if (hash) {
      const data = await readFile(target).catch(() => Buffer.alloc(0));
      binary = binary || data.includes(0);
    }
    entries.push({ path: item.path, change_type: item.type as ChangeEntry["change_type"], mode, content_sha256: hash, ...(item.oldPath ? { old_path: item.oldPath } : {}), binary });
  }
  const numstat = resultOrThrow(await runner.run(["diff", "--numstat", "--no-ext-diff", options.baseCommit, "--"], worktree));
  const trackedDiff = resultOrThrow(await runner.run(["diff", "--binary", "--no-ext-diff", options.baseCommit, "--"], worktree));
  const trackedDiffSha256 = createHash("sha256").update(trackedDiff).digest("hex");
  let diffLines = 0;
  for (const line of numstat.split(/\r?\n/)) { const [added, removed, ...pathParts] = line.split("\t"); const diffPath = pathParts.join("\t").replaceAll("\\", "/"); if (added === "-" || removed === "-") { const entry = entries.find((item) => item.path === diffPath); if (entry) entry.binary = true; continue; } diffLines += Number(added || 0) + Number(removed || 0); }
  const generatedPaths = (options.allowedGeneratedPaths ?? []).filter((pattern) => entries.some((entry) => matches(pattern, entry.path)));
  const trackedPaths = entries.filter((entry) => entry.change_type !== "added" || !status.find((item) => item.path === entry.path && item.type === "added")).map((entry) => entry.path);
  const untrackedPaths = status.filter((item) => item.type === "added" && item.path.startsWith("")).map((item) => item.path);
  const digest = createHash("sha256").update(JSON.stringify({ base_commit: options.baseCommit, branch_name: options.branchName, entries, diff_lines: diffLines, tracked_diff_sha256: trackedDiffSha256, tracked_paths: trackedPaths, untracked_paths: untrackedPaths, generated_paths: generatedPaths })).digest("hex");
  return { change_set_sha256: digest, base_commit: options.baseCommit, branch_name: options.branchName, entries, diff_lines: diffLines, tracked_paths: trackedPaths, untracked_paths: untrackedPaths, generated_paths: generatedPaths, tracked_diff_sha256: trackedDiffSha256 };
}

export function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export const computeChangeSet = calculateChangeSet;
