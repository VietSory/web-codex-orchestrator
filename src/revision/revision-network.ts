import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitCommandResult } from "../git/contracts.js";
import { GitRunner } from "../git/git-runner.js";
import { RevisionError } from "./contracts.js";

interface CleanBareTransport {
  root: string;
  bare: string;
  release(): Promise<void>;
}

function output(result: GitCommandResult, code: "REVISION_OPERATIONAL_ERROR" | "REVISION_PUSH_FAILED" = "REVISION_OPERATIONAL_ERROR"): string {
  if (result.exitCode !== 0) throw new RevisionError(code, result.stderr.trim() || result.stdout.trim() || `Git command failed: ${result.args.join(" ")}`);
  return result.stdout;
}

async function createCleanBareTransport(runner: GitRunner): Promise<CleanBareTransport> {
  const parent = runner.runtimeDirectory ? path.resolve(runner.runtimeDirectory) : os.tmpdir();
  let root = "";
  try {
    const parentReal = await realpath(parent);
    const parentStat = await lstat(parentReal);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new RevisionError("REVISION_STATE_UNSAFE", "Revision network runtime parent must be a real directory.");
    root = await mkdtemp(path.join(parentReal, "wco-revision-network-"));
    const bare = path.join(root, "transport.git");
    output(await runner.run(["init", "--bare", "--quiet", bare], root));
    const bareReal = await realpath(bare);
    const bareStat = await lstat(bareReal);
    if (bareReal !== bare || !bareStat.isDirectory() || bareStat.isSymbolicLink()) throw new RevisionError("REVISION_STATE_UNSAFE", "Revision clean Git transport must be a canonical real directory.");
    return {
      root,
      bare,
      async release(): Promise<void> { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RevisionError) throw error;
    throw new RevisionError("REVISION_OPERATIONAL_ERROR", `Cannot prepare clean revision Git transport: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve a remote head in a clean bare Git repository. This deliberately does
 * not run from the product worktree, so worktree-local url.*.insteadOf and
 * url.*.pushInsteadOf rules cannot rewrite the sealed transport URL.
 */
export async function runCleanLsRemote(runner: GitRunner, transportUrl: string, branch: string): Promise<GitCommandResult> {
  const transport = await createCleanBareTransport(runner);
  try {
    return await runner.run(["ls-remote", "--heads", transportUrl, `refs/heads/${branch}`], transport.bare);
  } finally {
    await transport.release();
  }
}

/**
 * Push one already-created commit through a clean bare sender. The sender sees
 * source objects read-only through Git alternates, but it has its own empty
 * local config. Network URL resolution therefore cannot be influenced by the
 * product worktree's mutable .git/config.
 */
export async function runCleanPush(
  runner: GitRunner,
  worktree: string,
  transportUrl: string,
  commitSha: string,
  branch: string,
): Promise<GitCommandResult> {
  const transport = await createCleanBareTransport(runner);
  try {
    const rawObjects = output(await runner.run(["rev-parse", "--git-path", "objects"], worktree)).trim();
    if (!rawObjects || rawObjects.includes("\0") || rawObjects.includes("\n") || rawObjects.includes("\r")) throw new RevisionError("REVISION_OPERATIONAL_ERROR", "Source Git object directory path is unsafe for clean transport.");
    const objectCandidate = path.isAbsolute(rawObjects) ? rawObjects : path.resolve(worktree, rawObjects);
    const objects = await realpath(objectCandidate).catch((error) => { throw new RevisionError("REVISION_OPERATIONAL_ERROR", `Cannot resolve source Git object directory: ${error instanceof Error ? error.message : String(error)}`); });
    const objectsStat = await lstat(objects);
    if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink()) throw new RevisionError("REVISION_OPERATIONAL_ERROR", "Source Git object directory must be a real directory.");

    const infoDirectory = path.join(transport.bare, "objects", "info");
    await mkdir(infoDirectory, { recursive: true });
    await writeFile(path.join(infoDirectory, "alternates"), `${objects}\n`, { flag: "wx", mode: 0o600 });

    output(await runner.run(["cat-file", "-e", `${commitSha}^{commit}`], transport.bare), "REVISION_PUSH_FAILED");
    return await runner.run(["push", transportUrl, `${commitSha}:refs/heads/${branch}`], transport.bare);
  } finally {
    await transport.release();
  }
}
