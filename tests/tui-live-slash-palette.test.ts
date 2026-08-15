import test from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, slashCommandSuggestions } from "../src/tui/slash-commands.js";
import { runInteractiveSession } from "../src/tui/session.js";

test("live slash suggestions appear immediately and narrow by prefix", () => {
  assert.equal(slashCommandSuggestions("/").length, SLASH_COMMANDS.length);
  assert.deepEqual(slashCommandSuggestions("/st").map((item) => item.command), ["/status"]);
  assert.deepEqual(
    slashCommandSuggestions("/web ").map((item) => item.command),
    ["/web status", "/web connect", "/web open", "/web disconnect"],
  );
  assert.deepEqual(slashCommandSuggestions("/config ").map((item) => item.command), ["/config web"]);
  assert.deepEqual(slashCommandSuggestions("/new "), []);
  assert.deepEqual(slashCommandSuggestions("ordinary goal"), []);
});

test("interactive session prefers the live composer when one is available", async () => {
  const output: string[] = [];
  let composerCalls = 0;
  let questionCalls = 0;
  let receivedCommand = "";

  await runInteractiveSession({
    input: process.stdin,
    output: process.stdout,
    write: (value) => output.push(value),
    question: async () => { questionCalls += 1; return "unused"; },
    composer: async (prompt) => { composerCalls += 1; assert.equal(prompt, "\n> "); return "/quit"; },
    close: () => undefined,
  }, {
    state: async () => ({ active: false, sealed: false, summary: "READY" }),
    newTask: async () => "unused",
    clarify: async () => "unused",
    command: async (command) => { receivedCommand = command; return { message: "bye", quit: true }; },
  });

  assert.equal(composerCalls, 1);
  assert.equal(questionCalls, 0);
  assert.equal(receivedCommand, "/quit");
  assert.match(output.join(""), /Web Codex Orchestrator/);
  assert.match(output.join(""), /bye/);
});
