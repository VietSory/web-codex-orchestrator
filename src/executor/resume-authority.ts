import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { ArtifactRegistrationRecord } from "../web-authority/contracts.js";
import type { RunReceipt } from "../run/contracts.js";
import { ExecutorError } from "./contracts.js";

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function cleanGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"]) if (typeof process.env[key] === "string") environment[key] = process.env[key]!;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await spawnBounded({ executable: "git", args: ["-C", cwd, ...args], environment: cleanGitEnvironment(), timeoutMs: 15_000, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024, shell: false });
  if (result.spawnError || result.cancelled || result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Resume Git attestation failed: ${result.stderr.trim() || "non-zero/truncated result"}`);
  return result.stdout;
}

async function boundedTaskFile(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 8 * 1024 * 1024) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted Task Bundle file is unsafe/oversized: ${filePath}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted Task Bundle file truncated: ${filePath}`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted Task Bundle file grew: ${filePath}`);
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted Task Bundle file changed: ${filePath}`);
    return bytes;
  } finally { await handle.close(); }
}

async function specSetSha(run: RunReceipt): Promise<string> {
  const names = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json"];
  const files: Array<{ name: string; bytes: Buffer }> = [];
  for (const name of names) files.push({ name, bytes: await boundedTaskFile(path.join(run.accepted_bundle_path, name)) });
  files.push({ name: "README.md", bytes: Buffer.from([
    "# Task Specification Overview", "", `Task ID: \`${run.task_id}\``, `Run ID: \`${run.run_id}\``, `Archive SHA-256: \`${run.archive_sha256}\``, "",
    "This directory contains the task specification and spec-lock.", "Files copied from the accepted task bundle are preserved verbatim.", "The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",
  ].join("\n") + "\n", "utf8") });
  const authoritative = files.sort((a, b) => lexical(a.name, b.name)).map((entry) => ({ path: `task/${entry.name}`, sha256: sha256(entry.bytes), size_bytes: entry.bytes.byteLength }));
  return sha256(canonicalJsonBuffer(authoritative));
}

export async function attestExecutorResumeAuthority(options: { run: RunReceipt; trustedRepoPath: string; registration: ArtifactRegistrationRecord }): Promise<void> {
  const { run, registration } = options;
  if (run.repository_id !== registration.repository.id || run.base_branch !== registration.repository.base_branch || run.base_commit !== registration.repository.base_commit || run.run_id !== registration.run_id) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Resume registration differs from canonical run identity.");
  const head = (await git(run.worktree_path, ["rev-parse", "HEAD"])).trim();
  if (head !== run.base_commit) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Resume worktree HEAD '${head}' differs from locked base '${run.base_commit}'.`);
  const tree = (await git(options.trustedRepoPath, ["rev-parse", `${run.base_commit}^{tree}`])).trim();
  if (tree !== registration.repository.tree_sha) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Resume base tree differs from Phase 9 registration.");
  const spec = await specSetSha(run);
  if (spec !== registration.bindings.spec_set_sha256) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Accepted Task Bundle spec set drifted after Phase 9 registration.");
}
