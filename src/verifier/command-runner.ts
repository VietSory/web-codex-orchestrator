import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

export class ChildProcessSandbox implements VerificationSandbox {
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    const started = performance.now();
    return await new Promise<SandboxRunResult>((resolve, reject) => {
      const child = spawn(executable, [...args], { cwd: options.cwd, shell: false, env: { ...options.env, PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false, timedOut = false;
      const append = (current: string, chunk: Buffer, maximum: number, stream: "stdout" | "stderr"): string => { const bytes = chunk.byteLength; if (stream === "stdout") stdoutBytes += bytes; else stderrBytes += bytes; const combined = current + chunk.toString("utf8"); if (Buffer.byteLength(combined) > maximum) { if (stream === "stdout") stdoutTruncated = true; else stderrTruncated = true; return combined.slice(-maximum); } return combined; };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, options.maximumOutputBytes, "stdout"); }); child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, options.maximumOutputBytes, "stderr"); });
      const timer = setTimeout(() => { timedOut = true; if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); }, options.timeoutMs);
      const abort = () => { timedOut = true; child.kill("SIGTERM"); }; options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject); child.once("close", (exitCode, signal) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve({ exitCode, signal, stdout, stderr, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, timed_out: timedOut, duration_ms: Math.max(0, Math.round(performance.now() - started)) }); });
    });
  }
}

export class CommandRunner extends ChildProcessSandbox {}
