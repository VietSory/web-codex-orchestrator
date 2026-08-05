import { spawn } from "node:child_process";
import path from "node:path";
import type { GitCommandResult } from "./contracts.js";

import type { PublishIdentityConfig } from "../config/contracts.js";
import type { PreparedPublishGitSecurity } from "../publish/publish-auth.js";

export interface GitRunnerSecurityOptions {
  identity?: PublishIdentityConfig;
  auth?: PreparedPublishGitSecurity;
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
    const started = Date.now();
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
        
    return await new Promise<GitCommandResult>((resolve, reject) => {
      const gitExecutable = env.WCO_GIT_EXECUTABLE || "git";
      const child = spawn(gitExecutable, effectiveArgs, {
        cwd,
        shell: false,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutBufs: Buffer[] = [];
      const stderrBufs: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutBufs.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrBufs.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => {
        let stdoutStr = Buffer.concat(stdoutBufs).toString("utf8");
        let stderrStr = Buffer.concat(stderrBufs).toString("utf8");
        
        if (this.security?.auth?.mode === "https_token") {
          const token = this.security.auth.askpassToken;
          if (token && token.length > 0) {
            // exact secret redaction
            stdoutStr = stdoutStr.split(token).join("[REDACTED]");
            stderrStr = stderrStr.split(token).join("[REDACTED]");
          }
        }
        
        resolve({
          executable: "git",
          args: effectiveArgs,
          cwd,
          exitCode: exitCode ?? 3,
          stdout: stdoutStr,
          stderr: stderrStr,
          duration_ms: Date.now() - started,
        });
      });
    });
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
