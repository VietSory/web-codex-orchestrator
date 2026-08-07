import { createHash } from "node:crypto";
import path from "node:path";
import type { StructuredValidationCommand } from "../bundle/contracts.js";
import type { GitRunner } from "../git/git-runner.js";
import type { ChangeSet, VerificationCommandResult } from "../execution/contracts.js";
import { ExecutionError } from "../execution/errors.js";
import { calculateChangeSet } from "../execution/change-set.js";
import { assertVerifierDidNotMutateSource } from "./side-effect-check.js";
import type { VerificationSandbox } from "./contracts.js";
import { validateStructuredValidationContract } from "./validation-contract.js";
import { redact } from "../evidence/log-redaction.js";

export interface VerifierOptions {
  worktreePath: string;
  baseCommit: string;
  branchName: string;
  validation: unknown;
  policy: { allowed_executables: string[]; allowed_environment_keys: string[]; maximum_command_seconds: number; maximum_output_bytes: number; allowed_generated_paths: string[] };
  sandbox: VerificationSandbox;
  runner?: GitRunner;
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
  expectedRefsSha256?: string | undefined;
}

function specificationHash(command: StructuredValidationCommand): string { return createHash("sha256").update(JSON.stringify(command)).digest("hex"); }
function boundedOutput(value: string, maximum: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) return { value, truncated: false };
  return { value: bytes.subarray(bytes.byteLength - maximum).toString("utf8"), truncated: true };
}

export async function verifyDeterministically(options: VerifierOptions): Promise<{ required_commands_passed: boolean; commands: VerificationCommandResult[]; changeSet: ChangeSet }> {
  const commands = (await validateStructuredValidationContract(options.validation, options.worktreePath, options.policy)).commands as StructuredValidationCommand[];
  const initial = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
  if (options.expectedRefsSha256 !== undefined && initial.refs_sha256 !== options.expectedRefsSha256) throw new ExecutionError("AGENT_COMMITTED_CHANGES", "Git refs changed before verification.");
  const results: VerificationCommandResult[] = [];
  let requiredPass = true;
  for (const command of commands) {
    if (options.signal?.aborted) throw new ExecutionError("INTERRUPTED", "Verification was cancelled.");
    const before = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
    const started = (options.now ?? (() => new Date()))();
    const cwd = path.resolve(options.worktreePath, command.cwd);
    const run = await options.sandbox.run(command.executable, command.args, { cwd, env: command.environment, timeoutMs: Math.min(command.timeout_seconds, options.policy.maximum_command_seconds) * 1000, maximumOutputBytes: Math.min(command.maximum_output_bytes, options.policy.maximum_output_bytes), network_access: false, writable_root: options.worktreePath, credential_directories: [], signal: options.signal });
    const finished = (options.now ?? (() => new Date()))();
    const status: VerificationCommandResult["status"] = run.timed_out ? "TIMEOUT" : run.exitCode === 0 ? "PASS" : "FAIL";
    if (status !== "PASS" && command.required) requiredPass = false;
    if (run.timed_out && command.required) requiredPass = false;
    const after = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
    const generatedPaths = assertVerifierDidNotMutateSource(before, after, options.policy.allowed_generated_paths);
    const redactedStdout = redact(run.stdout);
    const redactedStderr = redact(run.stderr);
    const boundedStdout = run.stdout_truncated ? { value: redactedStdout, truncated: false } : boundedOutput(redactedStdout, Math.min(command.maximum_output_bytes, options.policy.maximum_output_bytes));
    const boundedStderr = run.stderr_truncated ? { value: redactedStderr, truncated: false } : boundedOutput(redactedStderr, Math.min(command.maximum_output_bytes, options.policy.maximum_output_bytes));
    results.push({ result_version: "1.0", command_id: command.id, required: command.required, specification_sha256: specificationHash(command), executable: command.executable, args: [...command.args], cwd: command.cwd, environment_keys: Object.keys(command.environment).sort(), started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: run.duration_ms, exit_code: run.exitCode, signal: run.signal, timed_out: run.timed_out, stdout_bytes: run.stdout_bytes, stderr_bytes: run.stderr_bytes, stdout_truncated: run.stdout_truncated || boundedStdout.truncated, stderr_truncated: run.stderr_truncated || boundedStderr.truncated, stdout: boundedStdout.value, stderr: boundedStderr.value, generated_paths: generatedPaths, status });
    if (options.expectedRefsSha256 !== undefined && after.refs_sha256 !== options.expectedRefsSha256) throw new ExecutionError("VERIFIER_MUTATED_SOURCE", "Verifier changed Git refs or repository metadata.");
    if (run.cancelled) throw new ExecutionError("INTERRUPTED", "Verification was cancelled.");
    if (run.timed_out && command.required) throw new ExecutionError("VERIFIER_TIMEOUT", `Validation command timed out: ${command.id}`, { command: results[results.length - 1], commands: results });
    if (options.signal?.aborted) throw new ExecutionError("INTERRUPTED", "Verification was cancelled.");
  }
  const finalSet = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
  return { required_commands_passed: requiredPass, commands: results, changeSet: finalSet };
}

export class Verifier {
  constructor(private readonly options: VerifierOptions) {}
  run(): ReturnType<typeof verifyDeterministically> { return verifyDeterministically(this.options); }
}
