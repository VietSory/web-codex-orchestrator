import test from "node:test";
import assert from "node:assert/strict";
import { BoundedResourcePool } from "../src/orchestration/resource-pool.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("P11-PERF-001 bounded pool never exceeds configured active concurrency", async () => {
  const pool = new BoundedResourcePool(2, 8);
  let active = 0;
  let observedMaximum = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => pool.run(async () => {
    active += 1;
    observedMaximum = Math.max(observedMaximum, active);
    await sleep(10);
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(tasks), [0,1,2,3,4,5,6,7]);
  assert.equal(observedMaximum, 2);
  assert.equal(pool.snapshot().active, 0);
  assert.equal(pool.snapshot().queued, 0);
  assert.equal(pool.snapshot().completed, 8);
});

test("P11-PERF-002 full queue returns backpressure instead of spawning another worker", async () => {
  const pool = new BoundedResourcePool(1, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = pool.run(async () => { await gate; return 1; });
  const second = pool.run(async () => 2);
  await assert.rejects(() => pool.run(async () => 3), (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_BACKPRESSURE");
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test("P11-PERF-003 cancelled queued work is removed without consuming a worker slot", async () => {
  const pool = new BoundedResourcePool(1, 4);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = pool.run(async () => { await gate; return 1; });
  const controller = new AbortController();
  const queued = pool.run(async () => 2, controller.signal);
  controller.abort();
  await assert.rejects(() => queued, /cancelled/);
  assert.equal(pool.snapshot().queued, 0);
  release();
  assert.equal(await first, 1);
});
