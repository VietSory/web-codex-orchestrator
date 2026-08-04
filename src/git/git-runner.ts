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

  private identifySubcommand(args: readonly string[]): string | undefined {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === undefined) break;
      if (arg === "-c") {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      return arg;
    }
    return undefined;
  }

  private safeEnvironment(subcommand: string | undefined): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    
    if (this.runtimeDirectory !== undefined) {
      result.GIT_CONFIG_GLOBAL = path.join(this.runtimeDirectory, "empty-config");
    }
    
    for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
      const value = this.env[key];
      if (value !== undefined) result[key] = value;
    }

    if (this.security?.identity && (subcommand === "commit" || subcommand === "var")) {
      result.GIT_AUTHOR_NAME = this.security.identity.name;
      result.GIT_AUTHOR_EMAIL = this.security.identity.email;
      result.GIT_COMMITTER_NAME = this.security.identity.name;
      result.GIT_COMMITTER_EMAIL = this.security.identity.email;
    }

    if (this.security?.auth && (subcommand === "push" || subcommand === "ls-remote")) {
      if (this.security.auth.askpassScriptPath && this.security.auth.askpassToken) {
        result.GIT_ASKPASS = this.security.auth.askpassScriptPath;
        result.WCO_GIT_ASKPASS_TOKEN = this.security.auth.askpassToken;
      } else if (this.security.auth.sshAuthSock) {
        result.SSH_AUTH_SOCK = this.security.auth.sshAuthSock;
      }
    }

    return result;
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const started = Date.now();
    const subcommand = this.identifySubcommand(args);
    const effectiveArgs = this.runtimeDirectory === undefined
      ? [...args]
      : [
          "-c",
          `core.hooksPath=${path.join(this.runtimeDirectory, "empty-hooks")}`,
          "-c",
          "core.fsmonitor=false",
          ...args,
        ];
        
    return await new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn("git", effectiveArgs, {
        cwd,
        shell: false,
        env: this.safeEnvironment(subcommand),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({
        executable: "git",
        args: effectiveArgs,
        cwd,
        exitCode: exitCode ?? 3,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        duration_ms: Date.now() - started,
      }));
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
