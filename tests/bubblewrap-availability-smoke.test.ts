import test from "node:test";
import assert from "node:assert/strict";
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
  durationMs: 1,
};

test("Bubblewrap availability checks both binary presence and isolated namespace execution", { skip: process.platform !== "linux" }, async () => {
  const calls: Parameters<SpawnBounded>[0][] = [];
  const spawn: SpawnBounded = async (options) => { calls.push(options); return success; };
  await new BubblewrapVerificationSandbox(spawn).checkAvailability();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.executable, "bwrap");
  assert.deepEqual(calls[0]?.args, ["--version"]);
  assert.equal(calls[1]?.executable, "bwrap");
  assert.ok(calls[1]?.args.includes("--unshare-all"));
  assert.ok(calls[1]?.args.includes("--clearenv"));
  assert.ok(calls[1]?.args.includes("node"));
});
