import { spawnBounded } from "../runtime/spawn-bounded.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import crypto from "node:crypto";
import { ExecutorError, type ExecutorReceipt, type ExecutorTransactionOperation } from "./contracts.js";
import { readStableWorktreeFile } from "./worktree-io.js";
import type { GitPublishReceipt } from "../publish/contracts.js";

function cleanGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"]) if (typeof process.env[key] === "string") environment[key] = process.env[key]!;
  environment.GIT_TERMINAL_PROMPT = "0"; environment.GIT_OPTIONAL_LOCKS = "0"; environment.GIT_CONFIG_NOSYSTEM = "1";
  return environment;
}
async function git(worktree: string, args: string[], stdoutMaxBytes = 2 * 1024 * 1024): Promise<string> {
  const result = await spawnBounded({ executable: "git", args: ["-C", worktree, ...args], environment: cleanGitEnvironment(), timeoutMs: 15_000, stdoutMaxBytes, stderrMaxBytes: 64 * 1024, shell: false });
  if (result.spawnError || result.cancelled || result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Git change-set attestation failed: ${result.stderr.trim() || "non-zero/truncated result"}`);
  return result.stdout;
}
function parseStatusPaths(raw: string): string[] {
  if (!raw) return [];
  const paths: string[] = [];
  for (const record of raw.split("\0").filter(Boolean)) {
    if (record.length < 4 || record[2] !== " ") throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Unexpected git status record.");
    const status = record.slice(0, 2); if (status.includes("R") || status.includes("C")) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Rename/copy status is not valid for closed-world Harness operations.");
    paths.push(record.slice(3));
  }
  return paths.sort();
}
async function attestBaseHead(receipt: ExecutorReceipt): Promise<void> { const head = await readExecutorWorktreeHead(receipt); if (head !== receipt.base_commit) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Worktree HEAD '${head}' moved from Harness base '${receipt.base_commit}'.`); }
export async function readExecutorWorktreeHead(receipt: ExecutorReceipt): Promise<string> { return (await git(receipt.worktree_path, ["rev-parse", "HEAD"], 1024)).trim(); }
async function currentChangedPaths(receipt: ExecutorReceipt): Promise<string[]> { await attestBaseHead(receipt); return parseStatusPaths(await git(receipt.worktree_path, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"])); }
function originalMode(operation: ExecutorTransactionOperation): number | null { if (operation.postimage_sha256 === null) return null; return operation.kind === "create_file" ? 0o644 : operation.original_mode; }

function effectiveFinal(receipt: ExecutorReceipt, operation: ExecutorTransactionOperation): { sha256: string | null; mode: number | null } {
  const repairActive = receipt.repair && ["APPLIED", "VERIFIED"].includes(receipt.repair.state);
  const repair = repairActive ? receipt.repair!.operations.find((candidate) => candidate.path === operation.path) : undefined;
  if (!repair) return { sha256: operation.postimage_sha256, mode: originalMode(operation) };
  if (repair.kind === "delete_file") return { sha256: null, mode: null };
  if (repair.kind === "create_file") return { sha256: repair.postimage_sha256, mode: operation.original_mode ?? 0o644 };
  return { sha256: repair.postimage_sha256, mode: originalMode(operation) ?? operation.original_mode ?? 0o644 };
}

function differsFromBase(operation: ExecutorTransactionOperation, final: { sha256: string | null; mode: number | null }): boolean {
  if (operation.preimage_sha256 === null) return final.sha256 !== null;
  if (final.sha256 === null) return true;
  return final.sha256 !== operation.preimage_sha256 || final.mode !== operation.original_mode;
}

export function effectiveExecutorChangedPaths(receipt: ExecutorReceipt): string[] {
  return receipt.operations.filter((operation) => differsFromBase(operation, effectiveFinal(receipt, operation))).map((operation) => operation.path).sort();
}
function equalPaths(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

async function postimageDigest(receipt: ExecutorReceipt): Promise<string> {
  const postimages: Array<{ path: string; sha256: string | null; mode: number | null }> = [];
  for (const operation of receipt.operations) {
    const expected = effectiveFinal(receipt, operation); const current = await readStableWorktreeFile(receipt.worktree_path, operation.path);
    if (expected.sha256 === null) {
      if (current !== null) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Deleted/effectively absent path reappeared: '${operation.path}'.`);
      postimages.push({ path: operation.path, sha256: null, mode: null });
    } else {
      if (!current || current.sha256 !== expected.sha256 || expected.mode === null || current.mode !== expected.mode) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Effective postimage bytes or mode drifted: '${operation.path}'.`);
      postimages.push({ path: operation.path, sha256: current.sha256, mode: current.mode });
    }
  }
  postimages.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return crypto.createHash("sha256").update(canonicalJsonBuffer({ version: "1.2", run_id: receipt.run_id, artifact_sha256: receipt.artifact_sha256, base_commit: receipt.base_commit, postimages })).digest("hex");
}

export async function attestExecutorResumeChangedPaths(receipt: ExecutorReceipt): Promise<void> {
  const actual = await currentChangedPaths(receipt); const allowed = new Set(receipt.operations.map((operation) => operation.path)); const unexpected = actual.filter((filePath) => !allowed.has(filePath));
  if (unexpected.length > 0) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Crash-resume worktree contains unregistered changes: [${unexpected.join(", ")}].`);
}
export async function attestExecutorChangeSet(receipt: ExecutorReceipt): Promise<string> {
  const actual = await currentChangedPaths(receipt); const expected = effectiveExecutorChangedPaths(receipt);
  if (!equalPaths(actual, expected)) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", `Worktree changed-path set differs from effective Harness authority. Expected [${expected.join(", ")}], observed [${actual.join(", ")}].`);
  return await postimageDigest(receipt);
}
export async function attestPublishedExecutorChangeSet(receipt: ExecutorReceipt, publish: GitPublishReceipt): Promise<string> {
  if ((publish.state !== "COMMITTED" && publish.state !== "PUSHED") || publish.commit_sha === null) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Published change-set attestation requires an exact committed publish receipt.");
  const expected = effectiveExecutorChangedPaths(receipt); const publishedPaths = [...publish.expected_paths].sort();
  if (!equalPaths(publishedPaths, expected)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Published path set differs from effective Harness authority.");
  const status = await git(receipt.worktree_path, ["-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]); if (status.length !== 0) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Published worktree contains changes after the product commit.");
  const parents = (await git(receipt.worktree_path, ["rev-list", "--parents", "-n", "1", publish.commit_sha], 4 * 1024)).trim().split(/\s+/); if (parents.length !== 2 || parents[0] !== publish.commit_sha || parents[1] !== receipt.base_commit) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Published product commit does not have the exact locked base as its sole parent.");
  const changed = (await git(receipt.worktree_path, ["diff", "--name-only", "--no-renames", "-z", receipt.base_commit, publish.commit_sha, "--"])).split("\0").filter(Boolean).sort(); if (!equalPaths(changed, expected)) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Published commit path set differs from effective Harness authority.");
  const tree = expected.length ? await git(receipt.worktree_path, ["--literal-pathspecs", "ls-tree", "-rz", "--full-tree", publish.commit_sha, "--", ...expected]) : "";
  const records = new Map<string, { mode: string; oid: string }>();
  for (const record of tree.split("\0").filter(Boolean)) { const tab = record.indexOf("\t"); const header = tab >= 0 ? /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(record.slice(0, tab)) : null; const filePath = tab >= 0 ? record.slice(tab + 1) : ""; if (!header || !expected.includes(filePath) || records.has(filePath)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Published commit contains an unsupported effective-path entry."); records.set(filePath, { mode: header[1]!, oid: header[2]! }); }
  const snapshot = crypto.createHash("sha256"); for (const filePath of expected) { const entry = records.get(filePath); snapshot.update(filePath); snapshot.update("\0"); snapshot.update(entry ? "file" : "deleted"); snapshot.update("\0"); snapshot.update(entry?.mode ?? ""); snapshot.update("\0"); snapshot.update(entry?.oid ?? ""); snapshot.update("\0"); }
  if (snapshot.digest("hex") !== publish.approved_snapshot_sha256) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Published commit snapshot differs from the approved effective snapshot.");
  return await postimageDigest(receipt);
}
