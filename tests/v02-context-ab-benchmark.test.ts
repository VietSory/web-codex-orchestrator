import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkOrder, runContextAbBenchmark, sameOrderedPaths } from "../src/benchmark/context-ab.js";

const DIGEST = "a".repeat(64);

test("v0.2 native A/B benchmark alternates arm order to reduce fixed ordering bias", () => {
  assert.deepEqual(benchmarkOrder(1), ["baseline", "smart"]);
  assert.deepEqual(benchmarkOrder(3), ["baseline", "smart", "smart", "baseline", "baseline", "smart"]);
  assert.throws(() => benchmarkOrder(0), /1\.\.5/);
  assert.throws(() => benchmarkOrder(6), /1\.\.5/);
});

test("v0.2 benchmark path identity is collision-safe for filenames containing newlines", () => {
  const left = ["a\nb", "c"];
  const right = ["a", "b\nc"];
  assert.equal(left.join("\n"), right.join("\n"), "fixture must demonstrate the old delimiter collision");
  assert.equal(sameOrderedPaths(left, right), false);
  assert.equal(sameOrderedPaths(left, [...left]), true);
});

test("v0.2 A/B benchmark re-attests before every sample and summarizes provider metrics", async () => {
  const before: string[] = [];
  const report = await runContextAbBenchmark({
    repetitions: 2,
    expectedChangeSetSha256: DIGEST,
    beforeSample: async (arm, sequence) => { before.push(`${sequence}:${arm}`); },
    runSample: async (arm, sequence) => ({
      elapsed_ms: arm === "smart" ? 80 + sequence : 100 + sequence,
      verdict: "APPROVE",
      reviewed_change_set_sha256: DIGEST,
      usage: arm === "smart"
        ? { input_tokens: 80, cached_input_tokens: 20, output_tokens: 10 }
        : { input_tokens: 100, cached_input_tokens: 10, output_tokens: 12 },
    }),
  });

  assert.deepEqual(before, ["1:baseline", "2:smart", "3:smart", "4:baseline"]);
  assert.equal(report.baseline.samples, 2);
  assert.equal(report.smart.samples, 2);
  assert.equal(report.baseline.exact_digest_approval_rate, 1);
  assert.equal(report.smart.exact_digest_approval_rate, 1);
  assert.equal(report.baseline.input_tokens.mean, 100);
  assert.equal(report.smart.input_tokens.mean, 80);
  assert.equal(report.baseline.elapsed_ms.median, 102.5);
  assert.equal(report.smart.elapsed_ms.median, 82.5);
});

test("v0.2 A/B benchmark gives each provider sample a bounded abort signal", async () => {
  await assert.rejects(
    () => runContextAbBenchmark({
      repetitions: 1,
      expectedChangeSetSha256: DIGEST,
      sampleTimeoutMs: 10,
      runSample: async (_arm, _sequence, signal) => await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
  await assert.rejects(
    () => runContextAbBenchmark({
      repetitions: 1,
      expectedChangeSetSha256: DIGEST,
      sampleTimeoutMs: 0,
      runSample: async () => ({
        elapsed_ms: 1,
        verdict: "APPROVE",
        reviewed_change_set_sha256: DIGEST,
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    }),
    /positive safe integer/,
  );
});

test("v0.2 A/B benchmark counts only APPROVE on the exact expected digest as success", async () => {
  let index = 0;
  const report = await runContextAbBenchmark({
    repetitions: 1,
    expectedChangeSetSha256: DIGEST,
    runSample: async () => {
      index += 1;
      return {
        elapsed_ms: 1,
        verdict: "APPROVE",
        reviewed_change_set_sha256: index === 1 ? "b".repeat(64) : DIGEST,
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      };
    },
  });
  assert.equal(report.baseline.exact_digest_approval_rate, 0);
  assert.equal(report.smart.exact_digest_approval_rate, 1);
});

test("v0.2 A/B benchmark rejects missing or unsafe usage instead of fabricating zero-cost samples", async () => {
  await assert.rejects(
    () => runContextAbBenchmark({
      repetitions: 1,
      expectedChangeSetSha256: DIGEST,
      runSample: async () => ({
        elapsed_ms: 1,
        verdict: "APPROVE",
        reviewed_change_set_sha256: DIGEST,
        usage: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    }),
    /input_tokens/,
  );
});
