import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { redact } from "../src/evidence/log-redaction.js";

test("LOG-REDACTION-001 URL credentials are removed without changing the surrounding URL", () => {
  assert.equal(
    redact("clone=https://alice:super-secret@example.com/org/repo.git"),
    "clone=https://[REDACTED]@example.com/org/repo.git",
  );
  assert.equal(
    redact("mirror (ssh+git://alice@example.com/org/repo.git)"),
    "mirror (ssh+git://[REDACTED]@example.com/org/repo.git)",
  );
});

test("LOG-REDACTION-002 long scheme-like plaintext is processed within a bounded regression budget", () => {
  // The former URL regex retried an unbounded greedy scheme match at nearly
  // every character, making this input quadratic. Keep the sample large
  // enough to catch that regression without turning the test into a benchmark.
  const input = "x".repeat(64 * 1024);
  const startedAt = performance.now();
  const output = redact(input);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(output, input);
  assert.ok(elapsedMs < 2_000, `redaction took ${elapsedMs.toFixed(1)}ms; expected < 2000ms`);
});
