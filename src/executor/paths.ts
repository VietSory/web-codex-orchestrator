import fs from "node:fs/promises";
import path from "node:path";
import { ExecutorError } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assertIdentity(taskId: string, taskBundleSha256: string, artifactSha256: string): void {
  if (!SAFE_ID.test(taskId) || !SHA256.test(taskBundleSha256) || !SHA256.test(artifactSha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Unsafe executor path identity.");
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Executor state path escapes state root: ${target}`);
}

export interface ExecutorPaths {
  directory: string;
  receipt: string;
  lock: string;
  backups: string;
}

export function executorPaths(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): ExecutorPaths {
  assertIdentity(taskId, taskBundleSha256, artifactSha256);
  const root = path.resolve(stateDirectory);
  const directory = path.resolve(root, "executor", "runs", taskId, taskBundleSha256, "artifacts", artifactSha256);
  assertContained(root, directory);
  return { directory, receipt: path.join(directory, "executor-receipt.json"), lock: path.join(directory, "executor.lock"), backups: path.join(directory, "backups") };
}

export async function prepareExecutorDirectory(stateDirectory: string, directory: string): Promise<void> {
  const root = path.resolve(stateDirectory);
  assertContained(root, directory);
  await fs.mkdir(root, { recursive: true });
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Executor state ancestor is not a real directory: ${current}`);
  }
  const realRoot = await fs.realpath(root);
  const realDirectory = await fs.realpath(directory);
  const realRelative = path.relative(realRoot, realDirectory);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", "Executor state directory realpath escapes state root.");
}
