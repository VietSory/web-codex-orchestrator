import { spawnBounded } from "../runtime/spawn-bounded.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import crypto from "node:crypto";
import { ExecutorError, type ExecutorReceipt, type ExecutorTransactionOperation } from "./contracts.js";
import { readStableWorktreeFile } from "./worktree-io.js";

function cleanGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"]) if (typeof process.env[key] === "string") environment[key] = process.env[key]!;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  return environment;
}

async function git(worktree: string, args: string[], stdoutMaxBytes = 2 * 1024 * 1024): Promise<string> {
  const result = await spawnBounded({ executable: "git", args: ["-C", worktree, ...args], environment: cleanGitEnvironment(), timeoutMs: 15_000, stdoutMaxBytes, stderrMaxBytes: 64 * 1024, shell: false });
  if (result.spawnError || result.cancelled || result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Git change-set attestation failed: ${result.stderr.trim() || "non-zero/truncated result"}`);
  return result.stdout;
}

function parseStatusPaths(raw: string): string[] {
  if (!raw) return [];
  const records = raw.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (const record of records) {
    if (record.length < 4 || record[2] !== " ") throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Unexpected git status record.");
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Rename/copy status is not valid for closed-world Phase 10 operations.");
    paths.push(record.slice(3));
  }
  return paths.sort();
}

async function attestBaseHead(receipt: ExecutorReceipt): Promise<void> {
  const head = (await git(receipt.worktree_path, ["rev-parse", "HEAD"], 1024)).trim();
  if (head !== receipt.base_commit) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Worktree HEAD '${head}' moved from Phase 10 base '${receipt.base_commit}'.`);
}

async function currentChangedPaths(receipt: ExecutorReceipt): Promise<string[]> {
  await attestBaseHead(receipt);
  const raw = await git(receipt.worktree_path, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parseStatusPaths(raw);
}

function expectedMode(operation: ExecutorTransactionOperation): number | null {
  if (operation.postimage_sha256 === null) return null;
  return operation.kind === "create_file" ? 0o644 : operation.original_mode;
}

export async function attestExecutorResumeChangedPaths(receipt: ExecutorReceipt): Promise<void> {
  const actual = await currentChangedPaths(receipt);
  const allowed = new Set(receipt.operations.map((operation) => operation.path));
  const unexpected = actual.filter((filePath) => !allowed.has(filePath));
  if (unexpected.length > 0) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Crash-resume worktree contains unregistered changes: [${unexpected.join(", ")}].`);
}

export async function attestExecutorChangeSet(receipt: ExecutorReceipt): Promise<string> {
  const actual = await currentChangedPaths(receipt);
  const expected = receipt.operations.map((operation) => operation.path).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Worktree changed-path set differs from registered operations. Expected [${expected.join(", ")}], observed [${actual.join(", ")}].`);

  const postimages: Array<{ path: string; sha256: string | null; mode: number | null }> = [];
  for (const operation of receipt.operations) {
    const current = await readStableWorktreeFile(receipt.worktree_path, operation.path);
    const mode = expectedMode(operation);
    if (operation.postimage_sha256 === null) {
      if (current !== null) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Deleted path reappeared: '${operation.path}'.`);
      postimages.push({ path: operation.path, sha256: null, mode: null });
    } else {
      if (!current || current.sha256 !== operation.postimage_sha256 || mode === null || current.mode !== mode) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Postimage bytes or mode drifted after apply: '${operation.path}'.`);
      postimages.push({ path: operation.path, sha256: current.sha256, mode: current.mode });
    }
  }
  postimages.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return crypto.createHash("sha256").update(canonicalJsonBuffer({ version: "1.1", run_id: receipt.run_id, artifact_sha256: receipt.artifact_sha256, base_commit: receipt.base_commit, postimages })).digest("hex");
}
