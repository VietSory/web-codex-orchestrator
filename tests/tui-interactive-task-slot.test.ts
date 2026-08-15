import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveTaskSlot } from "../src/tui/interactive-task-slot.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("interactive task slot allows only one execution owner", async () => {
  const output: string[] = [];
  const gate = deferred<string>();
  const slot = new InteractiveTaskSlot((value) => output.push(value));

  const first = slot.start({ mode: "PAIR", goal: "first", run: async () => await gate.promise });
  const second = slot.start({ mode: "AUTOPILOT", goal: "second", run: async () => "must not run" });

  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.match(second.message, /already running/i);
  assert.deepEqual(slot.snapshot(), { mode: "PAIR", goal: "first", pause_requested: false });

  gate.resolve("done");
  await slot.waitForIdle();
  assert.equal(slot.isActive(), false);
  assert.match(output.join(""), /done/);
});

test("pause aborts cooperative work and records the safe-boundary hook once", async () => {
  const output: string[] = [];
  let safeBoundaryCalls = 0;
  let observedAbort = false;
  const slot = new InteractiveTaskSlot((value) => output.push(value));

  slot.start({
    mode: "AUTOPILOT",
    goal: "long task",
    pauseAtSafeBoundary: async () => { safeBoundaryCalls += 1; },
    run: async (signal) => {
      await new Promise<void>((resolve) => {
        const finish = () => { observedAbort = signal.aborted; resolve(); };
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      });
      return "paused";
    },
  });

  const first = await slot.requestPause();
  const second = await slot.requestPause();
  await slot.waitForIdle();

  assert.match(first, /Pause requested/);
  assert.match(second, /already requested|No background task/i);
  assert.equal(observedAbort, true);
  assert.equal(safeBoundaryCalls, 1);
  assert.equal(slot.isActive(), false);
});

test("pauseAndWait never leaves the background owner running", async () => {
  let finished = false;
  const slot = new InteractiveTaskSlot(() => undefined);
  slot.start({
    mode: "PAIR",
    goal: "safe exit",
    run: async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      finished = true;
      return "saved";
    },
  });

  const result = await slot.pauseAndWait();
  assert.equal(result.safe_to_exit, true);
  assert.equal(finished, true);
  assert.equal(slot.isActive(), false);
});

test("failed safe-boundary pause does not abort or permit process exit", async () => {
  const gate = deferred<string>();
  let observedAbort = false;
  const slot = new InteractiveTaskSlot(() => undefined);

  slot.start({
    mode: "PAIR",
    goal: "must stay owned",
    pauseAtSafeBoundary: async () => { throw new Error("lock unavailable"); },
    run: async (signal) => {
      signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      return await gate.promise;
    },
  });

  const result = await slot.pauseAndWait();
  assert.equal(result.safe_to_exit, false);
  assert.match(result.message, /could not be recorded safely/i);
  assert.equal(observedAbort, false);
  assert.equal(slot.isActive(), true);
  assert.deepEqual(slot.snapshot(), { mode: "PAIR", goal: "must stay owned", pause_requested: false });

  gate.resolve("finished normally");
  await slot.waitForIdle();
  assert.equal(slot.isActive(), false);
});
