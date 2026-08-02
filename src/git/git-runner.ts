import { spawn } from "node:child_process";
import path from "node:path";
import type { GitCommandResult } from "./contracts.js";

export class GitRunner {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    readonly runtimeDirectory?: string,
  ) {}

  private safeEnvironment(): NodeJS.ProcessEnv {
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
    return result;
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const started = Date.now();
    return await new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd,
        shell: false,
        env: this.safeEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({
        executable: "git",
        args: [...args],
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
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
}

export async function runGitCommand(args: readonly string[], cwd: string, runner = new GitRunner()): Promise<GitCommandResult> {
  return runner.run(args, cwd);
}
