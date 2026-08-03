import type { StructuredValidationCommand } from "../bundle/contracts.js";
import type { VerificationCommandResult } from "../execution/contracts.js";

export type ValidatedCommand = StructuredValidationCommand;
export interface VerificationResult { status: "PASS" | "FAIL"; required_commands_passed: boolean; commands: VerificationCommandResult[]; change_set_sha256: string; }
export interface CommandRunOptions { cwd: string; env: Record<string, string>; timeoutMs: number; maximumOutputBytes: number; maximum_stdout_bytes?: number; maximum_stderr_bytes?: number; network_access?: boolean; writable_root?: string; credential_directories?: readonly string[]; signal?: AbortSignal | undefined; }
export interface SandboxRunResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; stdout_bytes: number; stderr_bytes: number; stdout_truncated: boolean; stderr_truncated: boolean; timed_out: boolean; cancelled?: boolean; duration_ms: number; }
export interface VerificationSandbox {
  /** Optional preflight hook used before an agent is started. */
  checkAvailability?(): Promise<void>;
  run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult>;
}
