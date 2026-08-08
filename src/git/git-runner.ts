import path from "node:path";
import type { GitCommandResult } from "./contracts.js";
import { spawnBounded, spawnBoundedBinary } from "../runtime/spawn-bounded.js";
import type { PublishIdentityConfig } from "../config/contracts.js";
import type { PreparedPublishGitSecurity } from "../publish/publish-auth.js";

export interface GitRunnerSecurityOptions {
  identity?: PublishIdentityConfig;
  auth?: PreparedPublishGitSecurity;
}

export interface GitRunnerLimits {
  localTimeoutMs: number;
  networkTimeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
}

export const GIT_LOCAL_TIMEOUT_MS = 120_000;
export const GIT_NETWORK_TIMEOUT_MS = 300_000;
export const GIT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
export const GIT_STDERR_MAX_BYTES = 16 * 1024 * 1024;

const DEFAULT_LIMITS: GitRunnerLimits = {
  localTimeoutMs: GIT_LOCAL_TIMEOUT_MS,
  networkTimeoutMs: GIT_NETWORK_TIMEOUT_MS,
  stdoutMaxBytes: GIT_STDOUT_MAX_BYTES,
  stderrMaxBytes: GIT_STDERR_MAX_BYTES,
};

const CHECKIN_HELPER_PATTERN = "^filter\\..*\\.(clean|process)$";
const DIFF_HELPER_PATTERN = "^(diff\\.external|diff\\..*\\.(command|textconv))$";
const NETWORK_HELPER_PATTERN = "^(credential(\\..*)?\\.helper|remote\\..*\\.(receivepack|uploadpack))$";

export class GitRunner {
  private readonly limits: GitRunnerLimits;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    readonly runtimeDirectory?: string,
    private readonly security?: GitRunnerSecurityOptions,
    limits?: Partial<GitRunnerLimits>,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid GitRunner limit '${name}'.`);
    }
  }

  private getCommandTarget(args: readonly string[]): { subcommand: string | undefined; varTarget: string | undefined } {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === undefined) break;
      if (arg === "-c") {
        i += 2;
        continue;
      }
      if (arg === "--literal-pathspecs") {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) {
        return { subcommand: undefined, varTarget: undefined };
      }
      return { subcommand: arg, varTarget: args[i + 1] };
    }
    return { subcommand: undefined, varTarget: undefined };
  }

  private safeEnvironment(subcommand: string | undefined, varTarget: string | undefined): Record<string, string> {
    const result: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };

    if (this.runtimeDirectory !== undefined) {
      result.GIT_CONFIG_GLOBAL = path.join(this.runtimeDirectory, "empty-config");
    }

    for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "WCO_GIT_EXECUTABLE"]) {
      const value = this.env[key];
      if (value !== undefined) result[key] = value;
    }

    if (this.security?.identity) {
      if (subcommand === "commit" || (subcommand === "var" && (varTarget === "GIT_AUTHOR_IDENT" || varTarget === "GIT_COMMITTER_IDENT"))) {
        result.GIT_AUTHOR_NAME = this.security.identity.name;
        result.GIT_AUTHOR_EMAIL = this.security.identity.email;
        result.GIT_COMMITTER_NAME = this.security.identity.name;
        result.GIT_COMMITTER_EMAIL = this.security.identity.email;
      }
    }

    if (this.security?.auth?.mode === "https_token" && (subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote")) {
      result.GIT_ASKPASS = this.security.auth.askpassScriptPath;
      result.GIT_ASKPASS_REQUIRE = "force";
      result.WCO_GIT_ASKPASS_TOKEN = this.security.auth.askpassToken;
    }

    return result;
  }

  private runtimePrefix(): string[] {
    if (this.runtimeDirectory === undefined) return [];
    return [
      "-c",
      `core.hooksPath=${path.join(this.runtimeDirectory, "empty-hooks")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
    ];
  }

  private helperPatternFor(subcommand: string | undefined, args: readonly string[]): string | null {
    if (this.runtimeDirectory === undefined) return null;
    if (subcommand === "add") return CHECKIN_HELPER_PATTERN;
    if (subcommand === "hash-object" && args.some((arg) => arg === "--path" || arg.startsWith("--path="))) return CHECKIN_HELPER_PATTERN;
    if (subcommand === "diff") return DIFF_HELPER_PATTERN;
    if (subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote") return NETWORK_HELPER_PATTERN;
    return null;
  }

  private async unsafeLocalHelper(
    gitExecutable: string,
    cwd: string,
    env: Record<string, string>,
    pattern: string,
  ): Promise<{ unsafe: boolean; diagnostic: string | null }> {
    const probe = await spawnBounded({
      executable: gitExecutable,
      args: [
        ...this.runtimePrefix(),
        "config",
        "--local",
        "--includes",
        "--name-only",
        "--get-regexp",
        pattern,
      ],
      cwd,
      environment: env,
      timeoutMs: this.limits.localTimeoutMs,
      stdoutMaxBytes: Math.min(this.limits.stdoutMaxBytes, 1024 * 1024),
      stderrMaxBytes: Math.min(this.limits.stderrMaxBytes, 1024 * 1024),
      shell: false,
    });

    if (probe.spawnError || probe.timedOut || probe.stdoutTruncated || probe.stderrTruncated) {
      return { unsafe: true, diagnostic: "local Git helper policy could not be inspected safely" };
    }
    if (probe.exitCode === 1 && probe.stdout.length === 0) return { unsafe: false, diagnostic: null };
    if (probe.exitCode !== 0) return { unsafe: true, diagnostic: "local Git helper policy probe failed closed" };
    const key = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "configured helper";
    return { unsafe: true, diagnostic: `executable local Git helper is forbidden (${key})` };
  }

  private async blockedHelperDiagnostic(args: readonly string[], cwd: string, subcommand: string | undefined, env: Record<string, string>, gitExecutable: string): Promise<string | null> {
    const helperPattern = this.helperPatternFor(subcommand, args);
    if (!helperPattern) return null;
    const helper = await this.unsafeLocalHelper(gitExecutable, cwd, env, helperPattern);
    return helper.unsafe ? `WCO_GIT_UNSAFE_CONFIG: ${helper.diagnostic ?? "unsafe local Git helper configuration"}` : null;
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const { subcommand, varTarget } = this.getCommandTarget(args);
    const env = this.safeEnvironment(subcommand, varTarget);
    const gitExecutable = env.WCO_GIT_EXECUTABLE || "git";
    const blocked = await this.blockedHelperDiagnostic(args, cwd, subcommand, env, gitExecutable);
    if (blocked) {
      return {
        executable: "git",
        args: [...this.runtimePrefix(), ...args],
        cwd,
        exitCode: 3,
        stdout: "",
        stderr: blocked,
        duration_ms: 0,
      };
    }

    const effectiveArgs = [...this.runtimePrefix(), ...args];
    const networkCommand = subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote";
    const timeoutMs = networkCommand ? this.limits.networkTimeoutMs : this.limits.localTimeoutMs;
    const result = await spawnBounded({
      executable: gitExecutable,
      args: effectiveArgs,
      cwd,
      environment: env,
      timeoutMs,
      stdoutMaxBytes: this.limits.stdoutMaxBytes,
      stderrMaxBytes: this.limits.stderrMaxBytes,
      shell: false,
    });

    let stdout = result.stdout;
    let stderr = result.stderr;
    if (this.security?.auth?.mode === "https_token") {
      const token = this.security.auth.askpassToken;
      if (token.length > 0) {
        stdout = stdout.split(token).join("[REDACTED]");
        stderr = stderr.split(token).join("[REDACTED]");
      }
    }

    const diagnostics: string[] = [];
    if (result.timedOut) diagnostics.push(`WCO_GIT_TIMEOUT: command exceeded ${timeoutMs}ms`);
    if (result.stdoutTruncated || result.stderrTruncated) diagnostics.push("WCO_GIT_OUTPUT_LIMIT: command output exceeded the bounded Git output limit");
    if (result.spawnError) diagnostics.push(`WCO_GIT_SPAWN_ERROR: ${result.spawnError instanceof Error ? result.spawnError.message : String(result.spawnError)}`);
    if (diagnostics.length > 0) stderr = [stderr.trim(), ...diagnostics].filter(Boolean).join("\n");

    const failedByBoundary = result.timedOut || result.stdoutTruncated || result.stderrTruncated || result.spawnError !== undefined;
    return {
      executable: "git",
      args: effectiveArgs,
      cwd,
      exitCode: failedByBoundary ? (result.timedOut ? 124 : 3) : result.exitCode ?? 3,
      stdout,
      stderr,
      duration_ms: result.durationMs,
    };
  }

  async runBinary(args: readonly string[], cwd: string): Promise<Buffer> {
    const { subcommand, varTarget } = this.getCommandTarget(args);
    const env = this.safeEnvironment(subcommand, varTarget);
    const gitExecutable = env.WCO_GIT_EXECUTABLE || "git";
    const blocked = await this.blockedHelperDiagnostic(args, cwd, subcommand, env, gitExecutable);
    if (blocked) throw new Error(blocked);

    const effectiveArgs = [...this.runtimePrefix(), ...args];
    const networkCommand = subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote";
    if (networkCommand) throw new Error("WCO_GIT_BINARY_NETWORK_FORBIDDEN: binary Git runner is restricted to local evidence commands.");
    const result = await spawnBoundedBinary({
      executable: gitExecutable,
      args: effectiveArgs,
      cwd,
      environment: env,
      timeoutMs: this.limits.localTimeoutMs,
      stdoutMaxBytes: this.limits.stdoutMaxBytes,
      stderrMaxBytes: this.limits.stderrMaxBytes,
      shell: false,
    });
    if (result.spawnError || result.timedOut || result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").slice(-4096);
      const boundary = result.timedOut ? "timeout" : result.stdoutTruncated || result.stderrTruncated ? "output limit" : result.spawnError ? "spawn failure" : `exit ${result.exitCode ?? "null"}`;
      throw new Error(`WCO_GIT_BINARY_FAILED: ${boundary}${stderr ? `: ${stderr}` : ""}`);
    }
    return result.stdout;
  }

  async expect(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.run(args, cwd);
    if (result.exitCode !== 0) throw new Error(`git ${result.args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
}

export async function runGitCommand(args: readonly string[], cwd: string, runner = new GitRunner()): Promise<GitCommandResult> {
  return runner.run(args, cwd);
}
