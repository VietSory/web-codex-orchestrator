import test from "node:test";
import assert from "node:assert/strict";
import { setupExecutionHostStatus } from "../src/setup/setup-cli.js";

test("Linux is presented as the supported normal deterministic execution host", () => {
  const status = setupExecutionHostStatus("linux");
  assert.equal(status.severity, "ok");
  assert.match(status.value, /Linux\/WSL verification supported/i);
  assert.equal(status.guidance, undefined);
});

test("native Windows installation does not imply normal task execution support", () => {
  const status = setupExecutionHostStatus("win32");
  assert.equal(status.severity, "warn");
  assert.match(status.value, /native Windows.*requires Linux\/WSL/i);
  assert.match(status.guidance ?? "", /Open the project from WSL.*Bubblewrap/i);
});

test("other native hosts are told the same Bubblewrap execution boundary", () => {
  const status = setupExecutionHostStatus("darwin");
  assert.equal(status.severity, "warn");
  assert.match(status.value, /darwin.*requires Linux\/WSL/i);
  assert.match(status.guidance ?? "", /Linux environment.*Bubblewrap/i);
});
