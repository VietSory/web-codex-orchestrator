import path from "node:path";
import type { GitCommandResult } from "./contracts.js";
import type { PublishIdentityConfig } from "../config/contracts.js";
import type { PreparedPublishGitSecurity } from "../publish/publish-auth.js";
import { spawnBounded } from "../runtime/spawn-bounded.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_STDOUT_MAX_BYTES = 64 * 1024 * 1024;
const GIT_STDERR_MAX_BYTES = 4 * 1024 * 1024;

export interface GitRunnerSecurityOptions {
  identity?: PublishIdentityConfig;
  auth?: PreparedPublishGitSecurity;
}

function definedEnvironment(value: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

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

  private safeEnvironment(subcommand: string | undefined, varTarget: string | undefined): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {
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
    const result = await spawnBounded({
      executable: gitExecutable,
      args: effectiveArgs,
      cwd,
      shell: false,
      environment: definedEnvironment(env),
      timeoutMs: GIT_TIMEOUT_MS,
      stdoutMaxBytes: GIT_STDOUT_MAX_BYTES,
      stderrMaxBytes: GIT_STDERR_MAX_BYTES,
    });

    let stdoutStr = result.stdout;
    let stderrStr = result.stderr;
    if (result.timedOut) stderrStr = `${stderrStr}${stderrStr ? "\n" : ""}[WCO git command timed out]`;
    if (result.cancelled) stderrStr = `${stderrStr}${stderrStr ? "\n" : ""}[WCO git command cancelled]`;
    if (result.stdoutTruncated || result.stderrTruncated) stderrStr = `${stderrStr}${stderrStr ? "\n" : ""}[WCO git output exceeded bounded retention]`;
    if (result.spawnError) stderrStr = `${stderrStr}${stderrStr ? "\n" : ""}[WCO could not start git]`;

    if (this.security?.auth?.mode === "https_token") {
      const token = this.security.auth.askpassToken;
      if (token && token.length > 0) {
        stdoutStr = stdoutStr.split(token).join("[REDACTED]");
        stderrStr = stderrStr.split(token).join("[REDACTED]");
      }
    }

    const boundedFailure = result.spawnError || result.timedOut || result.cancelled || result.stdoutTruncated || result.stderrTruncated;
    return {
      executable: "git",
      args: effectiveArgs,
      cwd,
      exitCode: boundedFailure ? 3 : result.exitCode ?? 3,
      stdout: stdoutStr,
      stderr: stderrStr,
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
