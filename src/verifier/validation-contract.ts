import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { ValidationContract, StructuredValidationCommand } from "../bundle/contracts.js";
import { ExecutionError } from "../execution/errors.js";
import { validateEnvironment } from "./environment-policy.js";
import { validateArguments, validateExecutable } from "./executable-policy.js";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export async function validateStructuredValidationContract(value: unknown, worktreePath: string, policy: { allowed_executables: string[]; allowed_environment_keys: string[]; maximum_command_seconds: number; maximum_output_bytes: number }): Promise<ValidationContract> {
  if (!record(value) || !Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 256) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", "validation.json.commands must be a bounded non-empty array.");
  const ids = new Set<string>(); const commands: StructuredValidationCommand[] = [];
  for (const [index, raw] of value.commands.entries()) {
    const label = `validation.commands[${index}]`;
    if (!record(raw) || Object.keys(raw).some((key) => !["id", "executable", "args", "cwd", "environment", "required", "timeout_seconds", "maximum_output_bytes"].includes(key))) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", `${label} has unknown fields.`);
    if (typeof raw.id !== "string" || !raw.id || raw.id.length > 128 || ids.has(raw.id)) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", `${label}.id is invalid.`); ids.add(raw.id as string);
    const executable = validateExecutable(raw.executable, policy.allowed_executables);
    const args = validateArguments(executable, raw.args);
    if (typeof raw.cwd !== "string" || !raw.cwd || raw.cwd.includes("\\") || raw.cwd.split("/").includes("..") || path.isAbsolute(raw.cwd)) throw new ExecutionError("VALIDATION_CWD_UNSAFE", `${label}.cwd is unsafe.`);
    const resolvedCwd = path.resolve(worktreePath, raw.cwd);
    const root = `${path.resolve(worktreePath)}${path.sep}`;
    if (resolvedCwd !== path.resolve(worktreePath) && !resolvedCwd.startsWith(root)) throw new ExecutionError("VALIDATION_CWD_UNSAFE", `${label}.cwd escapes worktree.`);
    const cwdInfo = await lstat(resolvedCwd).catch(() => undefined);
    if (!cwdInfo || cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) throw new ExecutionError("VALIDATION_CWD_UNSAFE", `${label}.cwd must reference a real directory.`);
    const canonicalCwd = await realpath(resolvedCwd).catch(() => "");
    const canonicalRoot = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
    if (!canonicalCwd || (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(`${canonicalRoot}${path.sep}`))) throw new ExecutionError("VALIDATION_CWD_UNSAFE", `${label}.cwd resolves outside the worktree.`);
    if (typeof raw.required !== "boolean") throw new ExecutionError("VALIDATION_CONTRACT_INVALID", `${label}.required is invalid.`);
    if (typeof raw.timeout_seconds !== "number" || !Number.isInteger(raw.timeout_seconds) || raw.timeout_seconds <= 0 || raw.timeout_seconds > policy.maximum_command_seconds) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", `${label}.timeout_seconds exceeds trusted policy.`);
    if (typeof raw.maximum_output_bytes !== "number" || !Number.isInteger(raw.maximum_output_bytes) || raw.maximum_output_bytes <= 0 || raw.maximum_output_bytes > policy.maximum_output_bytes) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", `${label}.maximum_output_bytes exceeds trusted policy.`);
    const environment = validateEnvironment(raw.environment, policy.allowed_environment_keys);
    commands.push({ id: raw.id as string, executable, args, cwd: raw.cwd, environment, required: raw.required, timeout_seconds: raw.timeout_seconds, maximum_output_bytes: raw.maximum_output_bytes });
  }
  return { commands };
}
