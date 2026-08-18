import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetupCommand, setupExecutionHostStatus } from "../src/setup/setup-cli.js";

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
  assert.match(status.guidance ?? "", /Open this project from WSL.*Bubblewrap/i);
});

test("other native hosts are told the same Bubblewrap execution boundary", () => {
  const status = setupExecutionHostStatus("darwin");
  assert.equal(status.severity, "warn");
  assert.match(status.value, /darwin.*requires Linux\/WSL/i);
  assert.match(status.guidance ?? "", /Bubblewrap/i);
  assert.match(status.guidance ?? "", /Linux\/WSL environment/i);
});

test("unsupported native host stops before confirmation, setup state, or ChatGPT authorization", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "wco-native-host-gate-"));
  const output: string[] = [];
  let questions = 0;
  const code = await runSetupCommand([], cwd, {
    write: (value) => output.push(value),
    error: (value) => output.push(value),
    question: async () => { questions += 1; throw new Error("platform gate must run before confirmation"); },
  }, "win32");

  assert.equal(code, 1);
  assert.equal(questions, 0);
  const text = output.join("");
  assert.match(text, /native Windows host/i);
  assert.match(text, /Open this project from WSL/i);
  assert.match(text, /No WCO setup, ChatGPT authorization, or task state was created/i);
  assert.doesNotMatch(text, /Checking this Git repository|Set up WCO for the current Git repository/i);
});
