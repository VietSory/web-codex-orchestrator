import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatGptLogin, type ChatGptLoginRunner } from "../src/runtime/chatgpt-login.js";

const config = { runtime: { source: "bundled" } } as any;

function scriptedRunner(statuses: number[], calls: Array<{ args: string[]; stdio: string }>): ChatGptLoginRunner {
  return async (_runtime, args, stdio) => {
    calls.push({ args: [...args], stdio });
    const next = statuses.shift();
    assert.notEqual(next, undefined, `unexpected command: ${args.join(" ")}`);
    return next!;
  };
}

test("existing ChatGPT authorization is reused without another browser login", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-login-reuse-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const calls: Array<{ args: string[]; stdio: string }> = [];

  const authorized = await ensureChatGptLogin({
    config,
    stateDirectory: state,
    interactive: true,
    runCommand: scriptedRunner([0], calls),
  });

  assert.equal(authorized, true);
  assert.deepEqual(calls, [{ args: ["login", "status"], stdio: "ignore" }]);
});

test("interactive first use performs exactly one official login action and then verifies it", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-login-first-use-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const previousCi = process.env.CI;
  delete process.env.CI;
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });
  const calls: Array<{ args: string[]; stdio: string }> = [];

  const authorized = await ensureChatGptLogin({
    config,
    stateDirectory: state,
    interactive: true,
    runCommand: scriptedRunner([1, 0, 0], calls),
  });

  assert.equal(authorized, true);
  assert.deepEqual(calls, [
    { args: ["login", "status"], stdio: "ignore" },
    { args: ["login"], stdio: "inherit" },
    { args: ["login", "status"], stdio: "ignore" },
  ]);
  assert.equal(calls.filter((call) => call.args.length === 1 && call.args[0] === "login").length, 1);
});

test("non-interactive callers never start a browser authorization flow", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-login-noninteractive-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const calls: Array<{ args: string[]; stdio: string }> = [];

  const authorized = await ensureChatGptLogin({
    config,
    stateDirectory: state,
    interactive: false,
    runCommand: scriptedRunner([1], calls),
  });

  assert.equal(authorized, false);
  assert.deepEqual(calls, [{ args: ["login", "status"], stdio: "ignore" }]);
});

test("CI never opens the interactive login flow even when interactive=true", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-login-ci-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const previousCi = process.env.CI;
  process.env.CI = "true";
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });
  const calls: Array<{ args: string[]; stdio: string }> = [];

  const authorized = await ensureChatGptLogin({
    config,
    stateDirectory: state,
    interactive: true,
    runCommand: scriptedRunner([1], calls),
  });

  assert.equal(authorized, false);
  assert.deepEqual(calls, [{ args: ["login", "status"], stdio: "ignore" }]);
});
