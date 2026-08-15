import test from "node:test";
import assert from "node:assert/strict";
import { createInteractiveAbortScope } from "../src/tui/interactive-app.js";

class FakeSigintEvents {
  listener: (() => void) | null = null;
  once(event: "SIGINT", listener: () => void): void {
    assert.equal(event, "SIGINT");
    assert.equal(this.listener, null);
    this.listener = listener;
  }
  removeListener(event: "SIGINT", listener: () => void): void {
    assert.equal(event, "SIGINT");
    if (this.listener === listener) this.listener = null;
  }
  emit(): void { this.listener?.(); }
}

test("foreground AUTOPILOT receives a cooperative SIGINT abort signal", () => {
  const events = new FakeSigintEvents();
  const scope = createInteractiveAbortScope(undefined, events);

  assert.equal(scope.signal.aborted, false);
  assert.notEqual(events.listener, null);
  events.emit();
  assert.equal(scope.signal.aborted, true);

  scope.cleanup();
  assert.equal(events.listener, null);
  scope.cleanup();
  assert.equal(events.listener, null);
});

test("background AUTOPILOT reuses its task-slot signal without installing SIGINT ownership", () => {
  const events = new FakeSigintEvents();
  const controller = new AbortController();
  const scope = createInteractiveAbortScope(controller.signal, events);

  assert.equal(scope.signal, controller.signal);
  assert.equal(events.listener, null);
  scope.cleanup();
  assert.equal(events.listener, null);
});
