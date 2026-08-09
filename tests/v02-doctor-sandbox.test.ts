import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexVerificationSandbox } from "../src/verifier/codex-sandbox.js";
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
  durationMs: 1,
};

test("v0.2 sandbox preflight honors the stricter caller deadline", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-doctor-sandbox-"));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  let capturedTimeout: number | undefined;
  const spawn: SpawnBounded = async (options) => {
    capturedTimeout = options.timeoutMs;
    return success;
  };

  await new CodexVerificationSandbox(fakeResolvedCodexRuntime({ state_directory: state }), spawn).checkAvailability(5_000);
  assert.equal(capturedTimeout, 5_000);
});

test("v0.2 sandbox preflight rejects invalid deadlines before spawning", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-doctor-sandbox-invalid-"));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  let calls = 0;
  const spawn: SpawnBounded = async () => { calls += 1; return success; };
  const sandbox = new CodexVerificationSandbox(fakeResolvedCodexRuntime({ state_directory: state }), spawn);

  await assert.rejects(
    () => sandbox.checkAvailability(0),
    (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_SANDBOX_UNAVAILABLE",
  );
  await assert.rejects(
    () => sandbox.checkAvailability(60_001),
    (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_SANDBOX_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});
