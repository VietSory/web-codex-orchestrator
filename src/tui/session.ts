import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import readline from "node:readline/promises";
import { questionWithoutEcho } from "../shared/secret-prompt.js";
import { commandPalette, parseInteractiveInput, slashCommandSuggestions } from "./slash-commands.js";

const MAX_VISIBLE_SUGGESTIONS = 8;
const ARGUMENT_COMMANDS = new Set(["/new", "/auto", "/mode"]);

type Keypress = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };

function promptColumn(prompt: string): number {
  const newline = prompt.lastIndexOf("\n");
  return prompt.length - newline - 1;
}

async function liveSlashComposer(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let cursor = 0;
    let selected = 0;
    let paletteSuppressed = false;
    let settled = false;

    const currentSuggestions = () => paletteSuppressed ? [] : slashCommandSuggestions(value);

    const render = (): void => {
      const suggestions = currentSuggestions();
      if (selected >= suggestions.length) selected = Math.max(0, suggestions.length - 1);
      const pageStart = suggestions.length > MAX_VISIBLE_SUGGESTIONS
        ? Math.min(Math.floor(selected / MAX_VISIBLE_SUGGESTIONS) * MAX_VISIBLE_SUGGESTIONS, Math.max(0, suggestions.length - MAX_VISIBLE_SUGGESTIONS))
        : 0;
      const visible = suggestions.slice(pageStart, pageStart + MAX_VISIBLE_SUGGESTIONS);

      cursorTo(output, 0);
      clearScreenDown(output);
      output.write(`${prompt}${value}`);

      for (let index = 0; index < visible.length; index += 1) {
        const absolute = pageStart + index;
        const suggestion = visible[index]!;
        const marker = absolute === selected ? "›" : " ";
        output.write(`\n${marker} ${suggestion.command.padEnd(16)} ${suggestion.description}`);
      }

      let rowsBelow = visible.length;
      if (visible.length > 0) {
        output.write("\n  ↑/↓ select · Tab complete · Enter choose/run · Esc close");
        rowsBelow += 1;
      }

      if (rowsBelow > 0) moveCursor(output, 0, -rowsBelow);
      cursorTo(output, promptColumn(prompt) + cursor);
    };

    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      if (!wasRaw) input.setRawMode(false);
    };

    const finish = (answer: string): void => {
      if (settled) return;
      settled = true;
      cursorTo(output, 0);
      clearScreenDown(output);
      output.write(`${prompt}${answer}\n`);
      cleanup();
      resolve(answer);
    };

    const abort = (): void => {
      if (settled) return;
      settled = true;
      cursorTo(output, 0);
      clearScreenDown(output);
      output.write("\n");
      cleanup();
      const error = new Error("readline was closed") as Error & { code?: string };
      error.code = "ERR_USE_AFTER_CLOSE";
      reject(error);
    };

    const changed = (): void => {
      selected = 0;
      paletteSuppressed = false;
      render();
    };

    const acceptSelected = (appendArgumentSpace: boolean): boolean => {
      const suggestions = currentSuggestions();
      const suggestion = suggestions[selected];
      if (!suggestion) return false;
      value = suggestion.command;
      if (appendArgumentSpace && ARGUMENT_COMMANDS.has(suggestion.command)) value += " ";
      cursor = value.length;
      selected = 0;
      paletteSuppressed = false;
      render();
      return true;
    };

    const onKeypress = (text: string | undefined, key: Keypress): void => {
      if (key.ctrl && key.name === "c") { abort(); return; }
      if (key.ctrl && key.name === "d" && value.length === 0) { abort(); return; }

      if (key.name === "return" || key.name === "enter") {
        const suggestions = currentSuggestions();
        const suggestion = suggestions[selected];
        if (suggestion && value.trimStart() !== suggestion.command) {
          acceptSelected(false);
          return;
        }
        finish(value);
        return;
      }

      if (key.name === "tab") { acceptSelected(true); return; }
      if (key.name === "escape") { paletteSuppressed = true; render(); return; }

      if (key.name === "up" || key.name === "down") {
        const suggestions = currentSuggestions();
        if (suggestions.length === 0) return;
        selected = key.name === "up"
          ? (selected - 1 + suggestions.length) % suggestions.length
          : (selected + 1) % suggestions.length;
        render();
        return;
      }

      if (key.name === "left" || (key.ctrl && key.name === "b")) {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === "right" || (key.ctrl && key.name === "f")) {
        cursor = Math.min(value.length, cursor + 1);
        render();
        return;
      }
      if (key.name === "home" || (key.ctrl && key.name === "a")) { cursor = 0; render(); return; }
      if (key.name === "end" || (key.ctrl && key.name === "e")) { cursor = value.length; render(); return; }

      if (key.name === "backspace") {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor -= 1;
          changed();
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < value.length) {
          value = value.slice(0, cursor) + value.slice(cursor + 1);
          changed();
        }
        return;
      }

      if (key.ctrl || key.meta || !text) return;
      value = value.slice(0, cursor) + text + value.slice(cursor);
      cursor += text.length;
      changed();
    };

    input.on("keypress", onKeypress);
    render();
  });
}

export interface InteractiveIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  write(value: string): void;
  question(prompt: string): Promise<string>;
  composer?(prompt: string): Promise<string>;
  secret?(prompt: string): Promise<string>;
  close(): void;
}

export function terminalIo(): InteractiveIo {
  let rl: ReturnType<typeof readline.createInterface> | undefined;
  const get = () => rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  const reset = (): void => { rl?.close(); rl = undefined; };
  const secret = async (prompt: string): Promise<string> => {
    reset();
    const hidden = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try { return await questionWithoutEcho(hidden, prompt, (value) => process.stdout.write(value)); }
    finally { hidden.close(); }
  };
  const composer = async (prompt: string): Promise<string> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
      return await get().question(prompt);
    }
    reset();
    return await liveSlashComposer(prompt);
  };
  return {
    input: process.stdin,
    output: process.stdout,
    write: (value) => process.stdout.write(value),
    question: async (prompt) => await get().question(prompt),
    composer,
    secret,
    close: reset,
  };
}

export interface InteractiveHandlers {
  state(): Promise<{ active: boolean; sealed: boolean; summary: string }>;
  newTask(goal: string): Promise<string>;
  clarify(value: string): Promise<string>;
  command(command: string, args: string): Promise<{ message: string; quit?: boolean }>;
}

export async function runInteractiveSession(io: InteractiveIo, handlers: InteractiveHandlers): Promise<void> {
  io.write("\nWeb Codex Orchestrator · v0.3\n\n");
  try {
    while (true) {
      const state = await handlers.state();
      io.write(`${state.summary}\n`);
      const raw = io.composer ? await io.composer("\n> ") : await io.question("\n> ");
      if (raw.trim() === "/") { io.write(`\n${commandPalette()}\n`); continue; }
      const parsed = parseInteractiveInput(raw, state);
      if (parsed.kind === "empty") continue;
      if (parsed.kind === "new") { io.write(`${await handlers.newTask(parsed.goal!)}\n`); continue; }
      if (parsed.kind === "clarification") { io.write(`${await handlers.clarify(parsed.goal!)}\n`); continue; }
      if (parsed.kind === "sealed_block") { io.write("The current contract is sealed, so WCO did not change it. Use /new for a materially different task.\n"); continue; }
      const result = await handlers.command(parsed.command!, parsed.args ?? "");
      io.write(`${result.message}\n`);
      if (result.quit) return;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(message)) return;
    throw error;
  } finally { io.close(); }
}
