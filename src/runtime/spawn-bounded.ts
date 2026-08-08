import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { ExecutionError } from "../execution/errors.js";

export interface SpawnBoundedOptions {
  executable: string;
  args: readonly string[];
  cwd?: string;
  environment: Record<string, string>;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  shell?: false;
  signal?: AbortSignal;
}

interface SpawnBoundedBaseResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  spawnError?: unknown;
}

export interface SpawnBoundedResult extends SpawnBoundedBaseResult {
  stdout: string;
  stderr: string;
}

export interface SpawnBoundedBinaryResult extends SpawnBoundedBaseResult {
  stdout: Buffer;
  stderr: Buffer;
}

export type SpawnBounded = (options: SpawnBoundedOptions) => Promise<SpawnBoundedResult>;
export type SpawnBoundedBinary = (options: SpawnBoundedOptions) => Promise<SpawnBoundedBinaryResult>;

function assertArgument(value: string, label: string): void {
  if (value.includes("\u0000")) throw new ExecutionError("OPERATIONAL_ERROR", `${label} contains NUL.`);
}

function boundedTail(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, maximum: number): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.byteLength <= maximum) return { value: combined, truncated: false };
  return { value: combined.subarray(Math.max(0, combined.byteLength - maximum)), truncated: true };
}

async function spawnBoundedBuffers(options: SpawnBoundedOptions): Promise<SpawnBoundedBinaryResult> {
  assertArgument(options.executable, "Executable");
  for (const argument of options.args) assertArgument(argument, "Argument");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isFinite(options.stdoutMaxBytes) || options.stdoutMaxBytes < 0 || !Number.isFinite(options.stderrMaxBytes) || options.stderrMaxBytes < 0) {
    throw new ExecutionError("OPERATIONAL_ERROR", "Bounded process limits are invalid.");
  }

  const started = performance.now();
  return await new Promise<SpawnBoundedBinaryResult>((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const terminate = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may already have exited.
      }
    };
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        cancelled,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...(spawnError ? { spawnError } : {}),
      });
    };
    const abort = (): void => {
      cancelled = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 250);
    };

    const child = spawn(options.executable, [...options.args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      const bounded = boundedTail(stdout, chunk, options.stdoutMaxBytes);
      stdout = bounded.value;
      stdoutTruncated ||= bounded.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      const bounded = boundedTail(stderr, chunk, options.stderrMaxBytes);
      stderr = bounded.value;
      stderrTruncated ||= bounded.truncated;
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, exitSignal) => finish(exitCode, exitSignal));
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 250);
    }, options.timeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

export const spawnBoundedBinary: SpawnBoundedBinary = spawnBoundedBuffers;

export const spawnBounded: SpawnBounded = async (options) => {
  const result = await spawnBoundedBuffers(options);
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
  };
};

export const defaultSpawnBounded = spawnBounded;
