import path from "node:path";
import type { GitCommandResult } from "./contracts.js";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import type { PublishIdentityConfig } from "../config/contracts.js";
import type { PreparedPublishGitSecurity } from "../publish/publish-auth.js";

export interface GitRunnerSecurityOptions {
  identity?: PublishIdentityConfig;
  auth?: PreparedPublishGitSecurity;
}

export const GIT_LOCAL_TIMEOUT_MS = 120_000;
export const GIT_NETWORK_TIMEOUT_MS = 300_000;
export const GIT_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
export const GIT_STDERR_MAX_BYTES = 16 * 1024 * 1024;

export class GitRunner {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    readonly runtimeDirectory?: string,
    private readonly security?: GitRunnerSecurityOptions,
  ) {}

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

    if (this.security?.auth?.mode === "https_token" && (subcommand === "push" || subcommand === "ls-remote")) {
      result.GIT_ASKPASS = this.security.auth.askpassScriptPath;
      result.GIT_ASKPASS_REQUIRE = "force";
      result.WCO_GIT_ASKPASS_TOKEN = this.security.auth.askpassToken;
    }

    return result;
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const { subcommand, varTarget } = this.getCommandTarget(args);
    const effectiveArgs = this.runtimeDirectory === undefined
      ? [...args]
      : [
          "-c",
          `core.hooksPath=${path.join(this.runtimeDirectory, "empty-hooks")}`,
          "-c",
          "core.fsmonitor=false",
          ...args,
        ];

    const env = this.safeEnvironment(subcommand, varTarget);
    const gitExecutable = env.WCO_GIT_EXECUTABLE || "git";
    const networkCommand = subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote";
    const result = await spawnBounded({
      executable: gitExecutable,
      args: effectiveArgs,
      cwd,
      environment: env,
      timeoutMs: networkCommand ? GIT_NETWORK_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS,
      stdoutMaxBytes: GIT_STDOUT_MAX_BYTES,
      stderrMaxBytes: GIT_STDERR_MAX_BYTES,
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
    if (result.timedOut) diagnostics.push(`WCO_GIT_TIMEOUT: command exceeded ${networkCommand ? GIT_NETWORK_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS}ms`);
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

  async expect(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.run(args, cwd);
    if (result.exitCode !== 0) throw new Error(`git ${result.args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
}

export async function runGitCommand(args: readonly string[], cwd: string, runner = new GitRunner()): Promise<GitCommandResult> {
  return runner.run(args, cwd);
}
