import test from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, commandPalette, slashCommandSuggestions } from "../src/tui/slash-commands.js";
import { composerCursorGeometry, resolveEnterSelection, resolveSlashCompletion, runInteractiveSession, splitComposerPrompt } from "../src/tui/session.js";

test("live slash suggestions prioritize normal-user commands and hide legacy/advanced noise", () => {
  assert.equal(slashCommandSuggestions("/").length, SLASH_COMMANDS.length);
  assert.deepEqual(slashCommandSuggestions("/st").map((item) => item.command), ["/status"]);
  assert.deepEqual(
    slashCommandSuggestions("/web ").map((item) => item.command),
    ["/web status", "/web connect"],
  );
  assert.deepEqual(slashCommandSuggestions("/config "), []);
  assert.deepEqual(slashCommandSuggestions("/new "), []);
  assert.deepEqual(slashCommandSuggestions("ordinary goal"), []);

  const palette = commandPalette();
  assert.doesNotMatch(palette, /\/unitsall/);
  assert.doesNotMatch(palette, /\/web open|\/web disconnect|\/config web/);
  assert.match(palette, /\/new/);
  assert.match(palette, /\/auto/);
  assert.match(palette, /\/status/);
});

test("Enter and Tab completion do the intuitive thing for commands with and without arguments", () => {
  assert.deepEqual(resolveSlashCompletion("/n", "/new", "enter"), { value: "/new ", submit: false });
  assert.deepEqual(resolveSlashCompletion("/a", "/auto", "enter"), { value: "/auto ", submit: false });
  assert.deepEqual(resolveSlashCompletion("/m", "/mode", "tab"), { value: "/mode ", submit: false });
  assert.deepEqual(resolveSlashCompletion("/st", "/status", "enter"), { value: "/status", submit: true });
  assert.deepEqual(resolveSlashCompletion("/st", "/status", "tab"), { value: "/status", submit: false });

  assert.deepEqual(resolveEnterSelection("/new", "/new"), { value: "/new ", submit: false });
  assert.deepEqual(resolveEnterSelection("/auto", "/auto"), { value: "/auto ", submit: false });
  assert.deepEqual(resolveEnterSelection("/mode", "/mode"), { value: "/mode ", submit: false });
  assert.deepEqual(resolveEnterSelection("/n", "/new"), { value: "/new ", submit: false });
  assert.deepEqual(resolveEnterSelection("/st", "/status"), { value: "/status", submit: true });
  assert.equal(resolveEnterSelection("/status", "/status"), null);
});

test("live composer prints leading prompt spacing once and tracks wrapped cursor rows", () => {
  assert.deepEqual(splitComposerPrompt("\n> "), { prefix: "\n", prompt: "> " });
  assert.deepEqual(splitComposerPrompt("\r\n> "), { prefix: "\r\n", prompt: "> " });

  const wrapped = composerCursorGeometry("> ", "x".repeat(30), 30, 24);
  assert.deepEqual(wrapped, { cursorRow: 1, endRow: 1, cursorColumn: 8 });

  const movedBack = composerCursorGeometry("> ", "x".repeat(30), 5, 24);
  assert.deepEqual(movedBack, { cursorRow: 0, endRow: 1, cursorColumn: 7 });
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
  assert.match(output.join(""), /Type a goal to start/);
  assert.match(output.join(""), /bye/);
});

test("unchanged task summary is not reprinted after every command", async () => {
  const output: string[] = [];
  const inputs = ["/help", "/quit"];

  await runInteractiveSession({
    input: process.stdin,
    output: process.stdout,
    write: (value) => output.push(value),
    question: async () => "unused",
    composer: async () => inputs.shift() ?? "/quit",
    close: () => undefined,
  }, {
    state: async () => ({ active: false, sealed: false, summary: "SAME SUMMARY" }),
    newTask: async () => "unused",
    clarify: async () => "unused",
    command: async (command) => command === "/quit" ? { message: "bye", quit: true } : { message: "help text" },
  });

  assert.equal(output.join("").match(/SAME SUMMARY/g)?.length, 1);
  assert.match(output.join(""), /help text/);
});
