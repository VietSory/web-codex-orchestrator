import test from "node:test";
import assert from "node:assert/strict";
import { spawnBoundedBinary } from "../src/runtime/spawn-bounded.js";

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

test("SPAWN-BOUND-001 retains only the exact tail after large streamed output", async () => {
  const totalBytes = 1024 * 1024;
  const retainedBytes = 4096;
  const script = [
    `const total=${totalBytes};`,
    "const chunk=Buffer.alloc(1024, 0x61);",
    "let written=0;",
    "function pump(){",
    "  while(written<total){",
    "    const remaining=total-written;",
    "    const value=remaining>=chunk.length?chunk:chunk.subarray(0,remaining);",
    "    written+=value.length;",
    "    if(!process.stdout.write(value)){process.stdout.once('drain',pump);return;}",
    "  }",
    "}",
    "pump();",
  ].join("");

  const result = await spawnBoundedBinary({
    executable: process.execPath,
    args: ["-e", script],
    environment,
    timeoutMs: 10_000,
    stdoutMaxBytes: retainedBytes,
    stderrMaxBytes: 1024,
    shell: false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutBytes, totalBytes);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.byteLength, retainedBytes);
  assert.deepEqual(result.stdout, Buffer.alloc(retainedBytes, 0x61));
  assert.equal(result.stderrBytes, 0);
});

test("SPAWN-BOUND-002 zero-byte retention still counts output without retaining it", async () => {
  const result = await spawnBoundedBinary({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('bounded')"],
    environment,
    timeoutMs: 10_000,
    stdoutMaxBytes: 0,
    stderrMaxBytes: 0,
    shell: false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutBytes, 7);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.byteLength, 0);
});
