import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import readline from "node:readline/promises";
import { questionWithoutEcho } from "../shared/secret-prompt.js";
import { commandPalette, parseInteractiveInput, slashCommandSuggestions } from "./slash-commands.js";

const MAX_VISIBLE_SUGGESTIONS = 8;
const MAX_SESSION_HISTORY = 100;
const ARGUMENT_COMMANDS = new Set(["/new", "/auto", "/mode"]);

type Keypress = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };
type CompletionKind = "enter" | "tab";

function promptColumn(prompt: string): number {
  const newline = prompt.lastIndexOf("\n");
  return prompt.length - newline - 1;
}

function terminalColumns(output: NodeJS.WriteStream): number {
  const columns = output.columns;
  return Number.isSafeInteger(columns) && columns >= 24 ? columns : 80;
}

function fitLine(value: string, columns: number): string {
  if (value.length < columns) return value;
  return `${value.slice(0, Math.max(1, columns - 2))}…`;
}

function normalizeInlineInput(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

export function splitComposerPrompt(value: string): { prefix: string; prompt: string } {
  const prompt = value.replace(/^[\r\n]+/u, "");
  return { prefix: value.slice(0, value.length - prompt.length), prompt };
}

export function composerCursorGeometry(
  prompt: string,
  value: string,
  cursor: number,
  columns: number,
): { cursorRow: number; endRow: number; cursorColumn: number } {
  const safeColumns = Math.max(1, Math.trunc(columns));
  const boundedCursor = Math.max(0, Math.min(value.length, cursor));
  const absoluteCursor = promptColumn(prompt) + boundedCursor;
  const absoluteEnd = promptColumn(prompt) + value.length;
  return {
    cursorRow: Math.floor(absoluteCursor / safeColumns),
    endRow: Math.floor(absoluteEnd / safeColumns),
    cursorColumn: absoluteCursor % safeColumns,
  };
}

/** Pure completion rule used by the live TTY and UX regression tests. */
export function resolveSlashCompletion(value: string, command: string, kind: CompletionKind): { value: string; submit: boolean } {
  if (ARGUMENT_COMMANDS.has(command)) return { value: `${command} `, submit: false };
  return { value: command, submit: kind === "enter" && value.trimStart() !== command };
}

/**
 * Return a completion only when Enter should consume the highlighted palette
 * entry instead of submitting the current buffer verbatim. Exact commands that
 * still need an argument (/new, /auto, /mode) therefore stay open for input.
 */
export function resolveEnterSelection(value: string, command?: string): { value: string; submit: boolean } | null {
  if (!command) return null;
  const completion = resolveSlashCompletion(value, command, "enter");
  return value.trimStart() !== command || completion.value !== value ? completion : null;
}

async function liveSlashComposer(prompt: string, history: string[]): Promise<string> {
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
    let historyIndex = -1;
    let historyDraft = "";
    let renderedCursorRow = 0;

    const currentSuggestions = () => paletteSuppressed ? [] : slashCommandSuggestions(value);

    const clearRenderedBlock = (): void => {
      if (renderedCursorRow > 0) moveCursor(output, 0, -renderedCursorRow);
      cursorTo(output, 0);
      clearScreenDown(output);
      renderedCursorRow = 0;
    };

    const render = (): void => {
      const suggestions = currentSuggestions();
      if (selected >= suggestions.length) selected = Math.max(0, suggestions.length - 1);
      const pageStart = suggestions.length > MAX_VISIBLE_SUGGESTIONS
        ? Math.min(Math.floor(selected / MAX_VISIBLE_SUGGESTIONS) * MAX_VISIBLE_SUGGESTIONS, Math.max(0, suggestions.length - MAX_VISIBLE_SUGGESTIONS))
        : 0;
      const visible = suggestions.slice(pageStart, pageStart + MAX_VISIBLE_SUGGESTIONS);
      const columns = terminalColumns(output);

      clearRenderedBlock();
      output.write(`${prompt}${value}`);

      for (let index = 0; index < visible.length; index += 1) {
        const absolute = pageStart + index;
        const suggestion = visible[index]!;
        const marker = absolute === selected ? "›" : " ";
        output.write(`\n${fitLine(`${marker} ${suggestion.command.padEnd(16)} ${suggestion.description}`, columns)}`);
      }

      let rowsBelow = visible.length;
      if (visible.length > 0) {
        const range = suggestions.length > MAX_VISIBLE_SUGGESTIONS
          ? ` · ${pageStart + 1}-${pageStart + visible.length}/${suggestions.length}`
          : "";
        output.write(`\n${fitLine(`  ↑/↓ select · Tab complete · Enter choose/run · Esc close${range}`, columns)}`);
        rowsBelow += 1;
      }

      if (rowsBelow > 0) moveCursor(output, 0, -rowsBelow);
      const geometry = composerCursorGeometry(prompt, value, cursor, columns);
      if (geometry.cursorRow < geometry.endRow) moveCursor(output, 0, geometry.cursorRow - geometry.endRow);
      cursorTo(output, geometry.cursorColumn);
      renderedCursorRow = geometry.cursorRow;
    };

    const onResize = (): void => render();

    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      if (!wasRaw) input.setRawMode(false);
    };

    const remember = (answer: string): void => {
      if (!answer.trim()) return;
      if (history[0] !== answer) history.unshift(answer);
      if (history.length > MAX_SESSION_HISTORY) history.length = MAX_SESSION_HISTORY;
    };

    const finish = (answer: string): void => {
      if (settled) return;
      settled = true;
      remember(answer);
      clearRenderedBlock();
      output.write(`${prompt}${answer}\n`);
      cleanup();
      resolve(answer);
    };

    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearRenderedBlock();
      output.write("\n");
      cleanup();
      const error = new Error("readline was closed") as Error & { code?: string };
      error.code = "ERR_USE_AFTER_CLOSE";
      reject(error);
    };

    const changed = (): void => {
      selected = 0;
      paletteSuppressed = false;
      historyIndex = -1;
      historyDraft = "";
      render();
    };

    const setValue = (next: string): void => {
      value = next;
      cursor = value.length;
      selected = 0;
      paletteSuppressed = false;
      render();
    };

    const acceptSelected = (kind: CompletionKind): boolean => {
      const suggestions = currentSuggestions();
      const suggestion = suggestions[selected];
      if (!suggestion) return false;
      const completion = resolveSlashCompletion(value, suggestion.command, kind);
      if (completion.submit) finish(completion.value);
      else setValue(completion.value);
      return true;
    };

    const navigateHistory = (direction: "up" | "down"): void => {
      if (history.length === 0) return;
      if (historyIndex < 0) historyDraft = value;
      if (direction === "up") historyIndex = Math.min(history.length - 1, historyIndex + 1);
      else historyIndex = Math.max(-1, historyIndex - 1);
      value = historyIndex < 0 ? historyDraft : history[historyIndex]!;
      cursor = value.length;
      selected = 0;
      paletteSuppressed = false;
      render();
    };

    const deletePreviousWord = (): void => {
      if (cursor === 0) return;
      const before = value.slice(0, cursor);
      const start = before.search(/\S+\s*$/u);
      const from = start < 0 ? 0 : start;
      value = value.slice(0, from) + value.slice(cursor);
      cursor = from;
      changed();
    };

    const onKeypress = (text: string | undefined, key: Keypress): void => {
      if (key.ctrl && key.name === "c") { abort(); return; }
      if (key.ctrl && key.name === "d") {
        if (value.length === 0) { abort(); return; }
        if (cursor < value.length) {
          value = value.slice(0, cursor) + value.slice(cursor + 1);
          changed();
        }
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const suggestions = currentSuggestions();
        const completion = resolveEnterSelection(value, suggestions[selected]?.command);
        if (completion) {
          if (completion.submit) finish(completion.value);
          else setValue(completion.value);
          return;
        }
        finish(value);
        return;
      }

      if (key.name === "tab") { acceptSelected("tab"); return; }
      if (key.name === "escape") { paletteSuppressed = true; selected = 0; render(); return; }

      if (key.name === "up" || key.name === "down") {
        const suggestions = currentSuggestions();
        if (historyIndex < 0 && suggestions.length > 0) {
          selected = key.name === "up"
            ? (selected - 1 + suggestions.length) % suggestions.length
            : (selected + 1) % suggestions.length;
          render();
          return;
        }
        navigateHistory(key.name);
        return;
      }
      if (key.ctrl && (key.name === "p" || key.name === "n")) {
        navigateHistory(key.name === "p" ? "up" : "down");
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
      if (key.ctrl && key.name === "w") { deletePreviousWord(); return; }
      if (key.ctrl && key.name === "u") {
        if (cursor > 0) {
          value = value.slice(cursor);
          cursor = 0;
          changed();
        }
        return;
      }
      if (key.ctrl && key.name === "k") {
        if (cursor < value.length) {
          value = value.slice(0, cursor);
          changed();
        }
        return;
      }

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
      const inserted = normalizeInlineInput(text);
      if (!inserted) return;
      value = value.slice(0, cursor) + inserted + value.slice(cursor);
      cursor += inserted.length;
      changed();
    };

    input.on("keypress", onKeypress);
    output.on("resize", onResize);
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
  const history: string[] = [];
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
    const parts = splitComposerPrompt(prompt);
    if (parts.prefix) process.stdout.write(parts.prefix);
    return await liveSlashComposer(parts.prompt, history);
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
  io.write("\nWeb Codex Orchestrator · v0.3\n");
  io.write("Type a goal to start · type / for commands\n\n");
  let previousSummary: string | undefined;
  try {
    while (true) {
      const state = await handlers.state();
      if (state.summary !== previousSummary) {
        io.write(`${state.summary}\n`);
        previousSummary = state.summary;
      }
      const raw = io.composer ? await io.composer("\n> ") : await io.question("\n> ");
      if (raw.trim() === "/") { io.write(`\n${commandPalette()}\n`); continue; }
      const parsed = parseInteractiveInput(raw, state);
      if (parsed.kind === "empty") continue;
      if (parsed.kind === "new") { io.write(`${await handlers.newTask(parsed.goal!)}\n`); continue; }
      if (parsed.kind === "clarification") { io.write(`${await handlers.clarify(parsed.goal!)}\n`); continue; }
      if (parsed.kind === "sealed_block") { io.write("The current plan is locked for this task. Use /new for a materially different task.\n"); continue; }
      const result = await handlers.command(parsed.command!, parsed.args ?? "");
      if (result.message) io.write(`${result.message}\n`);
      if (result.quit) return;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(message)) return;
    throw error;
  } finally { io.close(); }
}
