import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";
import { defaultSpawnBounded, type SpawnBounded } from "../runtime/spawn-bounded.js";
import { codexCliArgs, minimalCodexEnvironment, type ResolvedCodexRuntime } from "../runtime/codex-runtime.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

export function sandboxCommandArgs(workingDirectory: string, executable: string, args: readonly string[]): string[] {
  return ["-c", "sandbox_workspace_write.network_access=false", "sandbox", "--permission-profile", ":workspace", "--cd", workingDirectory, "--", executable, ...args];
}

function assertNulFree(executable: string, args: readonly string[]): void {
  if (executable.includes("\u0000") || args.some((arg) => arg.includes("\u0000"))) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Sandbox executable arguments contain NUL.");
}

function assertExecutablePolicy(executable: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(executable) || executable.includes("/") || executable.includes("\\") || /\s/.test(executable)) {
    throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Validation executable is not allowlisted.");
  }
}

export class CodexVerificationSandbox implements VerificationSandbox {
  constructor(
    private readonly runtime: ResolvedCodexRuntime,
    private readonly spawnBounded: SpawnBounded = defaultSpawnBounded,
  ) {}

  async checkAvailability(): Promise<void> {
    const root = this.runtime.state_directory;
    if (!root) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "A state directory is required for the Codex sandbox smoke test.");
    let smokeDirectory: string | undefined;
    try {
      smokeDirectory = await mkdtemp(path.join(root, ".wco-codex-sandbox-smoke-"));
      const result = await this.spawnBounded({
        executable: this.runtime.executable,
        args: codexCliArgs(this.runtime, sandboxCommandArgs(smokeDirectory, process.execPath, ["-e", "process.exit(0)"])),
        cwd: smokeDirectory,
        environment: minimalCodexEnvironment(this.runtime),
        shell: false,
        timeoutMs: 15_000,
        stdoutMaxBytes: 16_384,
        stderrMaxBytes: 16_384,
      });
      if (result.spawnError || result.timedOut || result.exitCode !== 0) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "The Codex sandbox smoke test failed.");
    } catch (error) {
      if (error instanceof ExecutionError && error.code === "CODEX_SANDBOX_UNAVAILABLE") throw error;
      throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "The Codex sandbox is unavailable.");
    } finally {
      if (smokeDirectory) await rm(smokeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    assertNulFree(executable, args);
    assertExecutablePolicy(executable);
    if (options.network_access !== false || !options.writable_root || !Array.isArray(options.credential_directories) || options.credential_directories.length !== 0) {
      throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification sandbox options are not restrictive enough.");
    }
    const root = path.resolve(options.writable_root);
    const cwd = path.resolve(options.cwd);
    const [rootInfo, cwdInfo, canonicalRoot, canonicalCwd] = await Promise.all([
      lstat(root).catch(() => undefined),
      lstat(cwd).catch(() => undefined),
      realpath(root).catch(() => ""),
      realpath(cwd).catch(() => ""),
    ]);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink() || !canonicalRoot || canonicalRoot !== root || !canonicalCwd || (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(`${canonicalRoot}${path.sep}`))) {
      throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification root or cwd is not a canonical directory.");
    }
    const result = await this.spawnBounded({
      executable: this.runtime.executable,
      args: codexCliArgs(this.runtime, sandboxCommandArgs(canonicalCwd, executable, args)),
      cwd: canonicalCwd,
      environment: { ...minimalCodexEnvironment(this.runtime), ...options.env },
      shell: false,
      timeoutMs: options.timeoutMs,
      stdoutMaxBytes: options.maximum_stdout_bytes ?? options.maximumOutputBytes,
      stderrMaxBytes: options.maximum_stderr_bytes ?? options.maximumOutputBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.spawnError) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "The Codex sandbox could not be started.");
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdout_bytes: result.stdoutBytes,
      stderr_bytes: result.stderrBytes,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      duration_ms: result.durationMs,
    };
  }
}
