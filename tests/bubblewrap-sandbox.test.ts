import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutionError } from "../src/execution/errors.js";
import type { SpawnBounded, SpawnBoundedResult } from "../src/runtime/spawn-bounded.js";
import { BubblewrapVerificationSandbox } from "../src/verifier/bubblewrap-sandbox.js";

const success: SpawnBoundedResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 3,
};

async function fixture(): Promise<{ root: string; cwd: string; cleanup(): Promise<void> }> {
  const raw = await mkdtemp(path.join(os.tmpdir(), "wco-bwrap-test-"));
  const root = await realpath(raw);
  const cwd = path.join(root, "nested");
  await mkdir(cwd);
  return { root, cwd, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

function indexOfSequence(values: readonly string[], sequence: readonly string[]): number {
  for (let index = 0; index <= values.length - sequence.length; index += 1) {
    if (sequence.every((value, offset) => values[index + offset] === value)) return index;
  }
  return -1;
}

test("Bubblewrap verifier clears environment, unshares namespaces and binds only the worktree writable", { skip: process.platform !== "linux" }, async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const spawn: SpawnBounded = async (options) => { captured = options; return success; };
    const signal = new AbortController().signal;
    const result = await new BubblewrapVerificationSandbox(spawn).run("node", ["--version"], {
      cwd: state.cwd,
      env: { CI: "1" },
      timeoutMs: 1234,
      maximumOutputBytes: 999,
      maximum_stdout_bytes: 111,
      maximum_stderr_bytes: 222,
      network_access: false,
      writable_root: state.root,
      credential_directories: [],
      signal,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(captured?.executable, "bwrap");
    assert.equal(captured?.cwd, state.root);
    assert.equal(captured?.shell, false);
    assert.equal(captured?.timeoutMs, 1234);
    assert.equal(captured?.stdoutMaxBytes, 111);
    assert.equal(captured?.stderrMaxBytes, 222);
    assert.equal(captured?.signal, signal);
    assert.deepEqual(captured?.environment, { PATH: process.env.PATH ?? "" });

    const args = captured?.args ?? [];
    assert.ok(args.includes("--unshare-all"));
    assert.ok(args.includes("--die-with-parent"));
    assert.ok(args.includes("--new-session"));
    assert.ok(args.includes("--clearenv"));
    assert.ok(indexOfSequence(args, ["--bind", state.root, state.root]) >= 0);
    assert.ok(indexOfSequence(args, ["--chdir", state.cwd]) >= 0);
    assert.ok(indexOfSequence(args, ["--setenv", "HOME", "/tmp/wco-home"]) >= 0);
    assert.ok(indexOfSequence(args, ["--setenv", "CI", "1"]) >= 0);
    assert.ok(indexOfSequence(args, ["--", "node", "--version"]) >= 0);
    assert.equal(args.includes("/etc"), false);
    assert.equal(args.some((value) => value.includes(".local")), false);

    for (const runtimePath of ["/bin", "/sbin", "/lib", "/lib64"]) {
      const info = await lstat(runtimePath).catch(() => null);
      if (info?.isSymbolicLink()) {
        assert.ok(indexOfSequence(args, ["--symlink", await readlink(runtimePath), runtimePath]) >= 0);
      }
    }

    const writableBinds: string[] = [];
    for (let index = 0; index < args.length - 2; index += 1) if (args[index] === "--bind") writableBinds.push(args[index + 1]!);
    assert.deepEqual(writableBinds, [state.root]);
  } finally {
    await state.cleanup();
  }
});

test("Bubblewrap verifier rejects network, credentials, cwd escape and sandbox-owned environment overrides before spawning", { skip: process.platform !== "linux" }, async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const spawn: SpawnBounded = async () => { calls += 1; return success; };
    const sandbox = new BubblewrapVerificationSandbox(spawn);
    const base = { cwd: state.cwd, env: {}, timeoutMs: 10, maximumOutputBytes: 10, writable_root: state.root } as const;

    await assert.rejects(
      () => sandbox.run("node", [], { ...base, network_access: true, credential_directories: [] }),
      (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
    );
    await assert.rejects(
      () => sandbox.run("node", [], { ...base, network_access: false, credential_directories: ["/credentials"] }),
      (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
    );
    await assert.rejects(
      () => sandbox.run("node", [], { ...base, cwd: os.tmpdir(), network_access: false, credential_directories: [] }),
      (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
    );
    for (const key of ["PATH", "HOME", "TMPDIR"]) {
      await assert.rejects(
        () => sandbox.run("node", [], { ...base, env: { [key]: "/attacker-controlled" }, network_access: false, credential_directories: [] }),
        (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
      );
    }
    assert.equal(calls, 0);
  } finally {
    await state.cleanup();
  }
});

test("Bubblewrap availability fails closed and never falls back to host execution", { skip: process.platform !== "linux" }, async () => {
  let calls = 0;
  const unavailable: SpawnBounded = async (options) => {
    calls += 1;
    assert.equal(options.executable, "bwrap");
    return { ...success, exitCode: null, spawnError: new Error("missing") };
  };
  await assert.rejects(
    () => new BubblewrapVerificationSandbox(unavailable).checkAvailability(),
    (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
  );
  assert.equal(calls, 1);
});
