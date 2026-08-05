import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexVerificationSandbox, sandboxCommandArgs } from "../src/verifier/codex-sandbox.js";
import type { SpawnBounded, SpawnBoundedResult } from "../src/runtime/spawn-bounded.js";
import { ExecutionError } from "../src/execution/errors.js";
import { fakeResolvedCodexRuntime } from "./helpers/codex-runtime-fixture.js";

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
  durationMs: 4,
};

async function fixture(): Promise<{
  root: string;
  cwd: string;
  runtime: ReturnType<typeof fakeResolvedCodexRuntime>;
  cleanup(): Promise<void>;
}> {
  const rootRaw = await mkdtemp(path.join(os.tmpdir(), "wco-sandbox-test-"));
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(rootRaw);
  const cwd = path.join(root, "cwd");
  await mkdir(cwd);
  return {
    root,
    cwd,
    runtime: fakeResolvedCodexRuntime({ state_directory: root }),
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

test("sandbox uses the pinned 0.145.0 CLI contract with separate executable and args", () => {
  const command = sandboxCommandArgs("/trusted/worktree", "node", ["-e", "process.exit(0)"]);
  assert.deepEqual(command, [
    "-c",
    "sandbox_workspace_write.network_access=false",
    "sandbox",
    "--permission-profile",
    ":workspace",
    "--cd",
    "/trusted/worktree",
    "--",
    "node",
    "-e",
    "process.exit(0)",
  ]);
  assert.equal(command.includes("linux"), false);
  assert.equal(command.includes("macos"), false);
  assert.equal(command.includes("windows"), false);
});

test("sandbox forwards cwd, timeout, signal, independent caps, and shell=false", async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const spawn: SpawnBounded = async (options) => {
      captured = options;
      return success;
    };
    const signal = new AbortController().signal;
    const result = await new CodexVerificationSandbox(state.runtime, spawn).run("node", ["--version"], {
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
    assert.equal(captured?.executable, process.execPath);
    assert.deepEqual(captured?.args, [
      "/trusted/@openai/codex/bin/codex.js",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "sandbox",
      "--permission-profile",
      ":workspace",
      "--cd",
      state.cwd,
      "--",
      "node",
      "--version",
    ]);
    assert.equal(captured?.cwd, state.cwd);
    assert.equal(captured?.shell, false);
    assert.equal(captured?.timeoutMs, 1234);
    assert.equal(captured?.stdoutMaxBytes, 111);
    assert.equal(captured?.stderrMaxBytes, 222);
    assert.equal(captured?.signal, signal);
    assert.deepEqual(captured?.environment, { PATH: "/trusted/bin", CI: "1" });
  } finally {
    await state.cleanup();
  }
});

test("sandbox smoke test uses the temporary directory as --cd", async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const spawn: SpawnBounded = async (options) => {
      captured = options;
      return success;
    };
    await new CodexVerificationSandbox(state.runtime, spawn).checkAvailability();
    assert.ok(captured?.cwd?.startsWith(`${state.root}${path.sep}`));
    assert.deepEqual(captured?.args, [
      "/trusted/@openai/codex/bin/codex.js",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "sandbox",
      "--permission-profile",
      ":workspace",
      "--cd",
      captured?.cwd,
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ]);
  } finally {
    await state.cleanup();
  }
});

test("P4-109: workspace network config is overridden explicitly in every sandbox argv", async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const runtime = fakeResolvedCodexRuntime({
      state_directory: state.root,
      environment: {
        PATH: "/trusted/bin",
        CODEX_HOME: "/trusted/codex-home-with-network-enabled-config",
      },
    });
    const spawn: SpawnBounded = async (options) => {
      captured = options;
      return success;
    };
    await new CodexVerificationSandbox(runtime, spawn).run("node", ["--version"], {
      cwd: state.cwd,
      env: {},
      timeoutMs: 1000,
      maximumOutputBytes: 1000,
      network_access: false,
      writable_root: state.root,
      credential_directories: [],
    });
    assert.deepEqual(captured?.args?.slice(0, 3), [
      "/trusted/@openai/codex/bin/codex.js",
      "-c",
      "sandbox_workspace_write.network_access=false",
    ]);
    assert.equal(captured?.args?.includes("sandbox_workspace_write.network_access=true"), false);
    assert.equal(captured?.environment.CODEX_HOME, "/trusted/codex-home-with-network-enabled-config");
  } finally {
    await state.cleanup();
  }
});

test("sandbox rejects network access, credential directories, and unsafe cwd", async () => {
  const state = await fixture();
  try {
    const spawn: SpawnBounded = async () => {
      throw new Error("must not spawn");
    };
    const sandbox = new CodexVerificationSandbox(state.runtime, spawn);
    const base = {
      cwd: state.cwd,
      env: {},
      timeoutMs: 1,
      maximumOutputBytes: 10,
      writable_root: state.root,
    } as const;
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
  } finally {
    await state.cleanup();
  }
});

test("sandbox smoke test fails closed and never falls back to host execution", async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const unavailable: SpawnBounded = async () => {
      calls += 1;
      return { ...success, exitCode: null, spawnError: new Error("unavailable") };
    };
    await assert.rejects(
      () => new CodexVerificationSandbox(state.runtime, unavailable).checkAvailability(),
      (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_SANDBOX_UNAVAILABLE",
    );
    await assert.rejects(
      () => new CodexVerificationSandbox(state.runtime, unavailable).run("node", [], {
        cwd: state.cwd,
        env: {},
        timeoutMs: 10,
        maximumOutputBytes: 10,
        network_access: false,
        writable_root: state.root,
        credential_directories: [],
      }),
      (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE",
    );
    assert.equal(calls, 2);
  } finally {
    await state.cleanup();
  }
});
