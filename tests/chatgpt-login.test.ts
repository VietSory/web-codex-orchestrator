import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chatGptLoginCanOwnTerminal, ensureChatGptLogin, releaseParentInputForChatGptLogin, type ChatGptLoginRunner } from "../src/runtime/chatgpt-login.js";

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

test("interactive first use releases parent stdin, performs one official login, then verifies it", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-login-first-use-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const previousCi = process.env.CI;
  delete process.env.CI;
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });
  const calls: Array<{ args: string[]; stdio: string }> = [];
  let pauses = 0;
  const input = {
    isTTY: true,
    isRaw: false,
    pause() { pauses += 1; return this; },
  } as unknown as NodeJS.ReadStream;
  const output = { isTTY: true } as NodeJS.WriteStream;
  const runner: ChatGptLoginRunner = async (_runtime, args, stdio) => {
    if (args.length === 1 && args[0] === "login" && stdio === "inherit") assert.equal(pauses, 1, "parent stdin must be paused before inherited login starts");
    return await scriptedRunner([calls.length === 0 ? 1 : 0], calls)(_runtime, args, stdio);
  };

  const authorized = await ensureChatGptLogin({
    config,
    stateDirectory: state,
    interactive: true,
    input,
    output,
    runCommand: runner,
  });

  assert.equal(authorized, true);
  assert.equal(pauses, 1);
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

test("raw-mode TUI ownership blocks inherited interactive login", () => {
  assert.equal(chatGptLoginCanOwnTerminal({ isTTY: true, isRaw: true } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream), false);
  assert.equal(chatGptLoginCanOwnTerminal({ isTTY: true, isRaw: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream), true);
  assert.equal(chatGptLoginCanOwnTerminal({ isTTY: false, isRaw: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream), false);
});

test("parent stdin release only pauses an eligible non-raw TTY", () => {
  let pauses = 0;
  const input = { isTTY: true, isRaw: false, pause() { pauses += 1; return this; } } as unknown as NodeJS.ReadStream;
  releaseParentInputForChatGptLogin(input);
  assert.equal(pauses, 1);
  releaseParentInputForChatGptLogin({ isTTY: true, isRaw: true, pause() { pauses += 1; return this; } } as unknown as NodeJS.ReadStream);
  releaseParentInputForChatGptLogin({ isTTY: false, isRaw: false, pause() { pauses += 1; return this; } } as unknown as NodeJS.ReadStream);
  assert.equal(pauses, 1);
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
