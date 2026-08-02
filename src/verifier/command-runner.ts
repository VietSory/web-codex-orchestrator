import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";
import { redact } from "../evidence/log-redaction.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

export class ChildProcessSandbox implements VerificationSandbox {
  constructor(private readonly explicitlyEnabled = false) {}
  async checkAvailability(): Promise<void> {
    if (!this.explicitlyEnabled) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Unrestricted host process execution is disabled; inject a real verification sandbox.");
  }
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    if (!this.explicitlyEnabled) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Unrestricted host process execution is disabled; inject a real verification sandbox.");
    if (options.network_access !== false || options.writable_root === undefined || options.credential_directories === undefined || options.credential_directories.length !== 0) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Host process execution cannot enforce the requested sandbox contract.");
    const root = path.resolve(options.writable_root);
    const cwd = path.resolve(options.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Host process cwd is outside the writable root.");
    const [rootInfo, cwdInfo, canonicalRoot, canonicalCwd] = await Promise.all([
      lstat(root).catch(() => undefined),
      lstat(cwd).catch(() => undefined),
      realpath(root).catch(() => ""),
      realpath(cwd).catch(() => ""),
    ]);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink() || !canonicalRoot || !canonicalCwd || (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(`${canonicalRoot}${path.sep}`))) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Host process cwd or writable root is not a canonical directory.");
    const started = performance.now();
    return await new Promise<SandboxRunResult>((resolve, reject) => {
      const child = spawn(executable, [...args], { cwd, shell: false, env: { ...options.env, PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false, timedOut = false, cancelled = false;
      const append = (current: string, chunk: Buffer, maximum: number, stream: "stdout" | "stderr"): string => { const bytes = chunk.byteLength; if (stream === "stdout") stdoutBytes += bytes; else stderrBytes += bytes; const combined = Buffer.from(redact(Buffer.concat([Buffer.from(current), chunk]).toString("utf8")), "utf8"); if (combined.byteLength > maximum) { if (stream === "stdout") stdoutTruncated = true; else stderrTruncated = true; return combined.subarray(combined.byteLength - maximum).toString("utf8"); } return combined.toString("utf8"); };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, options.maximumOutputBytes, "stdout"); }); child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, options.maximumOutputBytes, "stderr"); });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* process already exited */ } };
      const timer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); killTimer = setTimeout(() => terminate("SIGKILL"), 250); }, options.timeoutMs);
      const abort = () => { cancelled = true; terminate("SIGTERM"); killTimer = setTimeout(() => terminate("SIGKILL"), 250); }; options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject); child.once("close", (exitCode, signal) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort); resolve({ exitCode, signal, stdout, stderr, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, timed_out: timedOut, cancelled, duration_ms: Math.max(0, Math.round(performance.now() - started)) }); });
    });
  }
}

export class CommandRunner extends ChildProcessSandbox {}
