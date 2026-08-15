import { spawnBounded } from "../runtime/spawn-bounded.js";
import type { ArtifactRegistrationRecord } from "../web-authority/contracts.js";
import { computeAcceptedTaskSpecSetSha256 } from "../web-authority/task-spec-authority.js";
import type { RunReceipt } from "../run/contracts.js";
import { ExecutorError } from "./contracts.js";

function cleanGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"]) if (typeof process.env[key] === "string") environment[key] = process.env[key]!;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  return environment;
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await spawnBounded({ executable: "git", args: ["-C", cwd, ...args], environment: cleanGitEnvironment(), timeoutMs: 15_000, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024, shell: false });
  if (result.spawnError || result.cancelled || result.timedOut || result.exitCode !== 0 || result.stdoutTruncated) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Resume Git attestation failed: ${result.stderr.trim() || "non-zero/truncated result"}`);
  return result.stdout;
}

export async function attestExecutorResumeAuthority(options: { run: RunReceipt; trustedRepoPath: string; registration: ArtifactRegistrationRecord; expectedWorktreeHead?: string }): Promise<void> {
  const { run, registration } = options;
  if (run.repository_id !== registration.repository.id || run.base_branch !== registration.repository.base_branch || run.base_commit !== registration.repository.base_commit || run.run_id !== registration.run_id) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Resume registration differs from canonical run identity.");
  const head = (await git(run.worktree_path, ["rev-parse", "HEAD"])).trim();
  const expectedHead = options.expectedWorktreeHead ?? run.base_commit;
  if (head !== expectedHead) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Resume worktree HEAD '${head}' differs from expected authority '${expectedHead}'.`);
  const tree = (await git(options.trustedRepoPath, ["rev-parse", `${run.base_commit}^{tree}`])).trim();
  if (tree !== registration.repository.tree_sha) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Resume base tree differs from Phase 9 registration.");
  let spec: string;
  try {
    spec = await computeAcceptedTaskSpecSetSha256(run.accepted_bundle_path, run.task_id, run.run_id, run.archive_sha256);
  } catch (error) {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted Task Bundle authority could not be revalidated on resume: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (spec !== registration.bindings.spec_set_sha256) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Accepted Task Bundle spec set drifted after Phase 9 registration.");
}
