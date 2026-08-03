import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexVerificationSandbox, sandboxCommandArgs } from "../src/verifier/codex-sandbox.js";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "../src/runtime/codex-runtime.js";
import type { SpawnBounded, SpawnBoundedResult } from "../src/runtime/spawn-bounded.js";
import { ExecutionError } from "../src/execution/errors.js";

const success: SpawnBoundedResult = { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, durationMs: 4 };

async function fixture(): Promise<{ root: string; cwd: string; runtime: ResolvedCodexRuntime; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-sandbox-test-"));
  const cwd = path.join(root, "cwd");
  await mkdir(cwd);
  return { root, cwd, runtime: { executable: "/trusted/codex", environment: { PATH: "/trusted/bin" }, state_directory: root }, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("sandbox uses the pinned 0.145.0 CLI contract with separate executable and args", () => {
  const command = sandboxCommandArgs("/trusted/worktree", "node", ["-e", "process.exit(0)"]);
  assert.deepEqual(command, ["-c", "sandbox_workspace_write.network_access=false", "sandbox", "--permission-profile", ":workspace", "--cd", "/trusted/worktree", "--", "node", "-e", "process.exit(0)"]);
  assert.equal(command.includes("linux"), false);
  assert.equal(command.includes("macos"), false);
  assert.equal(command.includes("windows"), false);
});

test("sandbox forwards cwd, timeout, signal, independent caps, and shell=false", async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const spawn: SpawnBounded = async (options) => { captured = options; return success; };
    const signal = new AbortController().signal;
    const result = await new CodexVerificationSandbox(state.runtime, spawn).run("node", ["--version"], { cwd: state.cwd, env: { CI: "1" }, timeoutMs: 1234, maximumOutputBytes: 999, maximum_stdout_bytes: 111, maximum_stderr_bytes: 222, network_access: false, writable_root: state.root, credential_directories: [], signal });
    assert.equal(result.exitCode, 0);
    assert.equal(captured?.executable, "/trusted/codex");
    assert.deepEqual(captured?.args, ["-c", "sandbox_workspace_write.network_access=false", "sandbox", "--permission-profile", ":workspace", "--cd", state.cwd, "--", "node", "--version"]);
    assert.equal(captured?.cwd, state.cwd);
    assert.equal(captured?.timeoutMs, 1234);
    assert.equal(captured?.stdoutMaxBytes, 111);
    assert.equal(captured?.stderrMaxBytes, 222);
    assert.equal(captured?.signal, signal);
    assert.deepEqual(captured?.environment, { PATH: "/trusted/bin", CI: "1" });
  } finally { await state.cleanup(); }
});

test("sandbox smoke test uses the temporary directory as --cd", async () => {
  const state = await fixture();
  try {
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const spawn: SpawnBounded = async (options) => { captured = options; return success; };
    await new CodexVerificationSandbox(state.runtime, spawn).checkAvailability();
    assert.ok(captured?.cwd?.startsWith(`${state.root}${path.sep}`));
    assert.deepEqual(captured?.args, ["-c", "sandbox_workspace_write.network_access=false", "sandbox", "--permission-profile", ":workspace", "--cd", captured?.cwd, "--", process.execPath, "-e", "process.exit(0)"]);
  } finally { await state.cleanup(); }
});

test("P4-109: workspace network config is overridden explicitly in every sandbox argv", async () => {
  const state = await fixture();
  const codexHome = await mkdtemp(path.join(state.root, "codex-home-"));
  try {
    await writeFile(path.join(codexHome, "config.toml"), "[sandbox_workspace_write]\nnetwork_access = true\n");
    let captured: Parameters<SpawnBounded>[0] | undefined;
    const runtime: ResolvedCodexRuntime = { ...state.runtime, environment: { ...state.runtime.environment, CODEX_HOME: codexHome } };
    const spawn: SpawnBounded = async (options) => { captured = options; return success; };
    await new CodexVerificationSandbox(runtime, spawn).run("node", ["--version"], { cwd: state.cwd, env: {}, timeoutMs: 1000, maximumOutputBytes: 1000, network_access: false, writable_root: state.root, credential_directories: [] });
    assert.deepEqual(captured?.args?.slice(0, 2), ["-c", "sandbox_workspace_write.network_access=false"]);
    assert.equal(captured?.args?.includes("sandbox_workspace_write.network_access=true"), false);
    assert.equal(captured?.environment.CODEX_HOME, codexHome);
  } finally { await rm(codexHome, { recursive: true, force: true }); await state.cleanup(); }
});

test("P4-110: real sandbox denies loopback access without host fallback", { skip: !process.env.WCO_CODEX_EXECUTABLE }, async () => {
  const state = await fixture();
  const marker = path.join(state.root, "sandbox-child-started.txt");
  let connected = false;
  const server = createServer((socket) => { connected = true; socket.end(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback test server did not expose a port.");
    const runtime = await resolveCodexRuntime({ codex_executable: process.env.WCO_CODEX_EXECUTABLE! }, state.root);
    const result = await new CodexVerificationSandbox(runtime).run("node", ["-e", "require('node:fs').writeFileSync(process.env.WCO_TEST_MARKER, 'STARTED'); const net = require('node:net'); const s = net.createConnection({ host: '127.0.0.1', port: Number(process.argv[1]) }, () => process.exit(0)); s.setTimeout(1500, () => process.exit(2)); s.on('error', () => process.exit(2));", String(address.port)], { cwd: state.cwd, env: { WCO_TEST_MARKER: marker }, timeoutMs: 5000, maximumOutputBytes: 8192, network_access: false, writable_root: state.root, credential_directories: [] });
    assert.notEqual(result.exitCode, 0);
    assert.equal(await readFile(marker, "utf8"), "STARTED");
    assert.equal(connected, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.cleanup();
  }
});

test("sandbox rejects network access, credential directories, and unsafe cwd", async () => {
  const state = await fixture();
  try {
    const spawn: SpawnBounded = async () => { throw new Error("must not spawn"); };
    const sandbox = new CodexVerificationSandbox(state.runtime, spawn);
    const base = { cwd: state.cwd, env: {}, timeoutMs: 1, maximumOutputBytes: 10, writable_root: state.root } as const;
    await assert.rejects(() => sandbox.run("node", [], { ...base, network_access: true, credential_directories: [] }), (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE");
    await assert.rejects(() => sandbox.run("node", [], { ...base, network_access: false, credential_directories: ["/credentials"] }), (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE");
    await assert.rejects(() => sandbox.run("node", [], { ...base, cwd: os.tmpdir(), network_access: false, credential_directories: [] }), (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE");
  } finally { await state.cleanup(); }
});

test("sandbox smoke test fails closed and never falls back to host execution", async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const unavailable: SpawnBounded = async () => { calls += 1; return { ...success, exitCode: null, spawnError: new Error("unavailable") }; };
    await assert.rejects(() => new CodexVerificationSandbox(state.runtime, unavailable).checkAvailability(), (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_SANDBOX_UNAVAILABLE");
    await assert.rejects(() => new CodexVerificationSandbox(state.runtime, unavailable).run("node", [], { cwd: state.cwd, env: {}, timeoutMs: 10, maximumOutputBytes: 10, network_access: false, writable_root: state.root, credential_directories: [] }), (error: unknown) => error instanceof ExecutionError && error.code === "VERIFIER_SANDBOX_UNAVAILABLE");
    assert.equal(calls, 2);
  } finally { await state.cleanup(); }
});
