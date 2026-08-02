import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
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

function parseStatus(output: string): Array<{ type: string; path: string; oldPath?: string; untracked: boolean }> {
  const result: Array<{ type: string; path: string; oldPath?: string; untracked: boolean }> = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]; if (!field) continue;
    const code = field.slice(0, 2); const rawPath = field.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      const next = fields[++i] ?? "";
      // With --porcelain=v1 -z Git emits the destination first and source
      // second for rename/copy records.
      result.push({ type: "renamed", path: rawPath.replaceAll("\\", "/"), oldPath: next.replaceAll("\\", "/"), untracked: false });
    } else {
      const type = code.includes("D") ? "deleted" : code.includes("A") || code === "??" ? "added" : "modified";
      result.push({ type, path: rawPath.replaceAll("\\", "/"), untracked: code === "??" });
    }
  }
  return result;
}

async function contentHash(worktree: string, relative: string, type: string): Promise<string | null> {
  if (type === "deleted") return null;
  const target = path.join(worktree, relative);
  const info = await lstat(target);
  if (info.isSymbolicLink()) return createHash("sha256").update(`symlink:${await readlink(target)}`).digest("hex");
  if (!info.isFile()) return null;
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function indexedMode(runner: GitRunner, worktree: string, relative: string): Promise<string | undefined> {
  const result = await runner.run(["ls-files", "--stage", "--", relative], worktree);
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  const mode = result.stdout.trim().split(/\s+/, 1)[0];
  return /^\d{6}$/.test(mode ?? "") ? mode : undefined;
}

interface MetadataRecord { root: string; relative: string; kind: string; value: string; }

async function collectGitMetadata(root: string, current = root, records: MetadataRecord[] = []): Promise<MetadataRecord[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(current, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Object databases are content-addressed and are not reachable through
    // the worktree policy. Git may refresh index stat data during read-only
    // commands, so staged content is covered by staged_diff while refs,
    // reflogs, hooks, and configuration are the mutable metadata we snapshot.
    if (entry.name === "objects" || entry.name === "index" || entry.name === "index.lock") continue;
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full).replaceAll(path.sep, "/");
    const info = await lstat(full);
    if (info.isSymbolicLink()) records.push({ root, relative, kind: "symlink", value: await readlink(full) });
    else if (info.isDirectory()) await collectGitMetadata(root, full, records);
    else if (info.isFile()) records.push({ root, relative, kind: "file", value: createHash("sha256").update(await readFile(full)).digest("hex") });
    else records.push({ root, relative, kind: "special", value: `${info.mode}:${info.size}` });
  }
  return records;
}

async function gitMetadataHash(worktree: string): Promise<string> {
  const pointer = path.join(worktree, ".git");
  const pointerInfo = await lstat(pointer).catch(() => undefined);
  if (!pointerInfo) return "missing";
  const pointerRecords: MetadataRecord[] = pointerInfo.isFile() && !pointerInfo.isSymbolicLink()
    ? [{ root: worktree, relative: ".git", kind: "file", value: createHash("sha256").update(await readFile(pointer)).digest("hex") }]
    : [];
  const roots: string[] = [pointer];
  if (pointerInfo.isFile() && !pointerInfo.isSymbolicLink()) {
    const content = await readFile(pointer, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/im.exec(content);
    if (match?.[1]) {
      const gitDir = path.resolve(worktree, match[1].trim());
      roots[0] = gitDir;
      const commonDirFile = path.join(gitDir, "commondir");
      const commonDir = await readFile(commonDirFile, "utf8").catch(() => "");
      if (commonDir.trim()) roots.push(path.resolve(gitDir, commonDir.trim()));
    }
  }
  const records: MetadataRecord[] = [...pointerRecords];
  for (const root of [...new Set(roots)]) {
    const info = await lstat(root).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      if (root === pointer && info?.isFile()) records.push({ root, relative: ".git", kind: "file", value: createHash("sha256").update(await readFile(root)).digest("hex") });
      else if (info) records.push({ root, relative: ".git", kind: "unsafe", value: `${info.mode}:${info.size}` });
      continue;
    }
    records.push(...await collectGitMetadata(root));
  }
  return createHash("sha256").update(JSON.stringify(records.map(({ root, ...record }) => record))).digest("hex");
}

async function repositoryRefsHash(runner: GitRunner, worktree: string): Promise<string> {
  const result = await runner.run(["for-each-ref", "--format=%(refname) %(objectname)"], worktree);
  if (result.exitCode !== 0) throw new ExecutionError("OPERATIONAL_ERROR", result.stderr.trim() || "Unable to snapshot Git refs.");
  const staged = await runner.run(["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"], worktree);
  if (staged.exitCode !== 0) throw new ExecutionError("OPERATIONAL_ERROR", staged.stderr.trim() || "Unable to snapshot the Git index.");
  const localConfig = await runner.run(["config", "--local", "--null", "--list"], worktree);
  if (localConfig.exitCode !== 0) throw new ExecutionError("OPERATIONAL_ERROR", localConfig.stderr.trim() || "Unable to snapshot local Git configuration.");
  const metadata = await gitMetadataHash(worktree);
  return createHash("sha256").update(JSON.stringify({ refs: result.stdout, staged_diff: staged.stdout, local_config: localConfig.stdout, git_metadata: metadata })).digest("hex");
}

async function countTextLines(target: string): Promise<number> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) return 0;
  const data = await readFile(target);
  if (data.includes(0)) return 0;
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return 0; }
  if (data.length === 0) return 0;
  return data.toString("utf8").split(/\r?\n/).length - (data[data.length - 1] === 10 ? 1 : 0);
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
    let mode = "000000"; let binary = false; let special = false;
    try {
      const info = await lstat(target);
      mode = await indexedMode(runner, worktree, item.path) ?? (info.isSymbolicLink() ? "120000" : (info.mode & 0o7777).toString(8).padStart(6, "0"));
      special = !info.isFile() && !info.isDirectory() && !info.isSymbolicLink();
      binary = special;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const hash = await contentHash(worktree, item.path, item.type);
    if (hash) {
      const targetInfo = await lstat(target).catch(() => undefined);
      // Never follow a changed symlink merely to classify its contents. The
      // link target is hashed above and path policy rejects the link itself.
      if (targetInfo?.isFile() && !targetInfo.isSymbolicLink()) {
        const data = await readFile(target).catch(() => Buffer.alloc(0));
        binary = binary || data.includes(0);
        if (!binary) { try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { binary = true; } }
      }
    }
    entries.push({ path: item.path, change_type: item.type as ChangeEntry["change_type"], mode, content_sha256: hash, ...(item.oldPath ? { old_path: item.oldPath } : {}), binary, special });
  }
  const numstat = resultOrThrow(await runner.run(["diff", "--numstat", "--no-ext-diff", options.baseCommit, "--"], worktree));
  const trackedDiff = resultOrThrow(await runner.run(["diff", "--binary", "--no-ext-diff", options.baseCommit, "--"], worktree));
  const trackedDiffSha256 = createHash("sha256").update(trackedDiff).digest("hex");
  let diffLines = 0;
  for (const line of numstat.split(/\r?\n/)) { const [added, removed, ...pathParts] = line.split("\t"); const diffPath = pathParts.join("\t").replaceAll("\\", "/"); if (added === "-" || removed === "-") { const entry = entries.find((item) => item.path === diffPath); if (entry) entry.binary = true; continue; } diffLines += Number(added || 0) + Number(removed || 0); }
  for (const item of status.filter((candidate) => candidate.untracked)) {
    const target = path.join(worktree, item.path);
    try { diffLines += await countTextLines(target); } catch { /* special objects are rejected by path policy */ }
  }
  const generatedPaths = (options.allowedGeneratedPaths ?? []).filter((pattern) => entries.some((entry) => matches(pattern, entry.path)));
  const trackedPaths = status.filter((item) => !item.untracked).flatMap((item) => item.oldPath ? [item.oldPath, item.path] : [item.path]).sort();
  const untrackedPaths = status.filter((item) => item.untracked).map((item) => item.path).sort();
  const refs_sha256 = await repositoryRefsHash(runner, worktree);
  const digest = createHash("sha256").update(JSON.stringify({ base_commit: options.baseCommit, branch_name: options.branchName, entries, diff_lines: diffLines, tracked_diff_sha256: trackedDiffSha256, tracked_paths: trackedPaths, untracked_paths: untrackedPaths, generated_paths: generatedPaths, refs_sha256 })).digest("hex");
  return { change_set_sha256: digest, base_commit: options.baseCommit, branch_name: options.branchName, entries, diff_lines: diffLines, tracked_paths: trackedPaths, untracked_paths: untrackedPaths, generated_paths: generatedPaths, tracked_diff_sha256: trackedDiffSha256, refs_sha256 };
}

export function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export const computeChangeSet = calculateChangeSet;
