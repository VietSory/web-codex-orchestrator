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
  now?: () => Date;
}

function specificationHash(command: StructuredValidationCommand): string { return createHash("sha256").update(JSON.stringify(command)).digest("hex"); }

export async function verifyDeterministically(options: VerifierOptions): Promise<{ required_commands_passed: boolean; commands: VerificationCommandResult[]; changeSet: ChangeSet }> {
  const commands = (await validateStructuredValidationContract(options.validation, options.worktreePath, options.policy)).commands as StructuredValidationCommand[];
  const initial = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
  const results: VerificationCommandResult[] = [];
  let requiredPass = true;
  for (const command of commands) {
    if (options.signal?.aborted) throw new ExecutionError("INTERRUPTED", "Verification was cancelled.");
    const started = (options.now ?? (() => new Date()))();
    const cwd = path.resolve(options.worktreePath, command.cwd);
    const run = await options.sandbox.run(command.executable, command.args, { cwd, env: command.environment, timeoutMs: Math.min(command.timeout_seconds, options.policy.maximum_command_seconds) * 1000, maximumOutputBytes: Math.min(command.maximum_output_bytes, options.policy.maximum_output_bytes), network_access: false, writable_root: options.worktreePath, credential_directories: [], signal: options.signal });
    const finished = (options.now ?? (() => new Date()))();
    const status: VerificationCommandResult["status"] = run.timed_out ? "TIMEOUT" : run.exitCode === 0 ? "PASS" : "FAIL";
    if (status !== "PASS" && command.required) requiredPass = false;
    if (run.timed_out && command.required) requiredPass = false;
    results.push({ result_version: "1.0", command_id: command.id, specification_sha256: specificationHash(command), executable: command.executable, args: [...command.args], cwd: command.cwd, environment_keys: Object.keys(command.environment).sort(), started_at: started.toISOString(), finished_at: finished.toISOString(), duration_ms: run.duration_ms, exit_code: run.exitCode, signal: run.signal, timed_out: run.timed_out, stdout_bytes: run.stdout_bytes, stderr_bytes: run.stderr_bytes, stdout_truncated: run.stdout_truncated, stderr_truncated: run.stderr_truncated, stdout: redact(run.stdout), stderr: redact(run.stderr), generated_paths: [], status });
    const after = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
    assertVerifierDidNotMutateSource(initial, after, options.policy.allowed_generated_paths);
  }
  const finalSet = await calculateChangeSet({ worktreePath: options.worktreePath, baseCommit: options.baseCommit, branchName: options.branchName, runner: options.runner, allowedGeneratedPaths: options.policy.allowed_generated_paths });
  return { required_commands_passed: requiredPass, commands: results, changeSet: finalSet };
}

export class Verifier {
  constructor(private readonly options: VerifierOptions) {}
  run(): ReturnType<typeof verifyDeterministically> { return verifyDeterministically(this.options); }
}
