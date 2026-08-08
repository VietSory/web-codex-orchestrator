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

class BoundedByteTail {
  private chunks: Buffer[] = [];
  private head = 0;
  private retainedBytes = 0;
  private wasTruncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    if (this.maximumBytes === 0) {
      this.wasTruncated = true;
      return;
    }

    if (chunk.byteLength >= this.maximumBytes) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.byteLength - this.maximumBytes))];
      this.head = 0;
      this.retainedBytes = this.maximumBytes;
      this.wasTruncated ||= chunk.byteLength > this.maximumBytes;
      return;
    }

    const exactChunk = Buffer.from(chunk);
    this.chunks.push(exactChunk);
    this.retainedBytes += exactChunk.byteLength;

    while (this.retainedBytes > this.maximumBytes && this.head < this.chunks.length) {
      const excess = this.retainedBytes - this.maximumBytes;
      const first = this.chunks[this.head]!;
      this.wasTruncated = true;
      if (first.byteLength <= excess) {
        this.head += 1;
        this.retainedBytes -= first.byteLength;
        continue;
      }
      this.chunks[this.head] = Buffer.from(first.subarray(excess));
      this.retainedBytes -= excess;
    }

    if (this.head > 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  toBuffer(): Buffer {
    if (this.retainedBytes === 0) return Buffer.alloc(0);
    return Buffer.concat(this.chunks.slice(this.head), this.retainedBytes);
  }
}

async function spawnBoundedBuffers(options: SpawnBoundedOptions): Promise<SpawnBoundedBinaryResult> {
  assertArgument(options.executable, "Executable");
  for (const argument of options.args) assertArgument(argument, "Argument");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isFinite(options.stdoutMaxBytes) || options.stdoutMaxBytes < 0 || !Number.isFinite(options.stderrMaxBytes) || options.stderrMaxBytes < 0) {
    throw new ExecutionError("OPERATIONAL_ERROR", "Bounded process limits are invalid.");
  }

  const started = performance.now();
  return await new Promise<SpawnBoundedBinaryResult>((resolve) => {
    const stdoutTail = new BoundedByteTail(options.stdoutMaxBytes);
    const stderrTail = new BoundedByteTail(options.stderrMaxBytes);
    let stdoutBytes = 0;
    let stderrBytes = 0;
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
        stdout: stdoutTail.toBuffer(),
        stderr: stderrTail.toBuffer(),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutTail.truncated,
        stderrTruncated: stderrTail.truncated,
        timedOut,
        cancelled,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...(spawnError ? { spawnError } : {}),
      });
    };
    const scheduleKill = (): void => {
      if (killTimer) return;
      killTimer = setTimeout(() => terminate("SIGKILL"), 250);
    };
    const abort = (): void => {
      cancelled = true;
      terminate("SIGTERM");
      scheduleKill();
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
      stdoutTail.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      stderrTail.append(chunk);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, exitSignal) => finish(exitCode, exitSignal));
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      scheduleKill();
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
