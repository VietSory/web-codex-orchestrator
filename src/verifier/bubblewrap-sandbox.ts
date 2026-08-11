import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";
import { defaultSpawnBounded, type SpawnBounded } from "../runtime/spawn-bounded.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

const BWRAP = "bwrap";
const SMOKE_TIMEOUT_MS = 5_000;
const MAX_ENVIRONMENT_KEYS = 128;

function assertExecutablePolicy(executable: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(executable) || executable.includes("/") || executable.includes("\\") || /\s/.test(executable)) {
    throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Validation executable is not allowlisted.");
  }
}

function assertNulFree(value: string, label: string): void {
  if (value.includes("\u0000")) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", `${label} contains NUL.`);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const [info, canonical] = await Promise.all([lstat(resolved), realpath(resolved)]);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolved) {
    throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", `${label} must be a canonical non-symlink directory.`);
  }
  return canonical;
}

function ancestorDirectories(value: string): string[] {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const result: string[] = [];
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean).slice(0, -1)) {
    current = path.join(current, segment);
    result.push(current);
  }
  return result;
}

async function existingDirectory(value: string): Promise<string | null> {
  try {
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return await realpath(value);
  } catch {
    return null;
  }
}

async function readonlyRuntimeDirectories(writableRoot: string): Promise<string[]> {
  const candidates = new Set<string>(["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) candidates.add(path.resolve(entry));
  const nodeBin = path.dirname(process.execPath);
  candidates.add(nodeBin);
  candidates.add(path.dirname(nodeBin));

  const discovered: string[] = [];
  for (const candidate of candidates) {
    const directory = await existingDirectory(candidate);
    if (!directory || directory === writableRoot || isContained(writableRoot, directory)) continue;
    discovered.push(directory);
  }
  discovered.sort((left, right) => left.length - right.length || left.localeCompare(right));

  const resolved: string[] = [];
  for (const directory of discovered) {
    if (resolved.some((parent) => directory === parent || isContained(parent, directory))) continue;
    resolved.push(directory);
  }
  return resolved;
}

function boundedEnvironment(environment: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(environment);
  if (entries.length > MAX_ENVIRONMENT_KEYS) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Validation environment exceeds the sandbox key cap.");
  const merged = new Map<string, string>([
    ["PATH", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"],
    ["HOME", "/tmp/wco-home"],
    ["TMPDIR", "/tmp"],
  ]);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", `Validation environment key '${key}' is invalid.`);
    assertNulFree(value, `Validation environment '${key}'`);
    merged.set(key, value);
  }
  return [...merged.entries()].sort(([left], [right]) => left.localeCompare(right));
}

async function sandboxArgs(executable: string, args: readonly string[], options: CommandRunOptions): Promise<string[]> {
  assertExecutablePolicy(executable);
  assertNulFree(executable, "Validation executable");
  for (const argument of args) assertNulFree(argument, "Validation argument");
  if (process.platform !== "linux") throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "PAIR verification requires a Linux/WSL Bubblewrap sandbox on this build.");
  if (options.network_access !== false || !options.writable_root || !Array.isArray(options.credential_directories) || options.credential_directories.length !== 0) {
    throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification sandbox options are not restrictive enough.");
  }

  const writableRoot = await canonicalDirectory(options.writable_root, "Verification writable root");
  const cwd = await canonicalDirectory(options.cwd, "Verification cwd");
  if (!isContained(writableRoot, cwd)) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification cwd escapes the writable root.");

  const runtimeDirectories = await readonlyRuntimeDirectories(writableRoot);
  const command: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/wco-home",
  ];

  const created = new Set<string>(["/tmp"]);
  const ensureAncestors = (target: string): void => {
    for (const ancestor of ancestorDirectories(target)) {
      if (ancestor === "/" || created.has(ancestor)) continue;
      command.push("--dir", ancestor);
      created.add(ancestor);
    }
  };

  for (const directory of runtimeDirectories) {
    ensureAncestors(directory);
    command.push("--ro-bind", directory, directory);
    created.add(directory);
  }
  ensureAncestors(writableRoot);
  command.push("--bind", writableRoot, writableRoot, "--chdir", cwd, "--clearenv");
  for (const [key, value] of boundedEnvironment(options.env)) command.push("--setenv", key, value);
  command.push("--", executable, ...args);
  return command;
}

export class BubblewrapVerificationSandbox implements VerificationSandbox {
  constructor(private readonly spawnBounded: SpawnBounded = defaultSpawnBounded) {}

  async checkAvailability(): Promise<void> {
    if (process.platform !== "linux") throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Bubblewrap verification is supported only on Linux/WSL.");
    const result = await this.spawnBounded({ executable: BWRAP, args: ["--version"], environment: { PATH: process.env.PATH ?? "" }, timeoutMs: SMOKE_TIMEOUT_MS, stdoutMaxBytes: 16_384, stderrMaxBytes: 16_384, shell: false });
    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Bubblewrap is unavailable. Install bwrap; WCO will not run deterministic verification without filesystem/network isolation.");
    }
    await access("/proc");
  }

  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    const result = await this.spawnBounded({
      executable: BWRAP,
      args: await sandboxArgs(executable, args, options),
      ...(options.writable_root ? { cwd: options.writable_root } : {}),
      environment: { PATH: process.env.PATH ?? "" },
      shell: false,
      timeoutMs: options.timeoutMs,
      stdoutMaxBytes: options.maximum_stdout_bytes ?? options.maximumOutputBytes,
      stderrMaxBytes: options.maximum_stderr_bytes ?? options.maximumOutputBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.spawnError) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Bubblewrap could not be started.");
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdout_bytes: result.stdoutBytes,
      stderr_bytes: result.stderrBytes,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      duration_ms: result.durationMs,
    };
  }
}
