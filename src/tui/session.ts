import readline from "node:readline/promises";
import { commandPalette, parseInteractiveInput } from "./slash-commands.js";

export interface InteractiveIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; write(value: string): void; question(prompt: string): Promise<string>; close(): void; }
export function terminalIo(): InteractiveIo {
  let rl: ReturnType<typeof readline.createInterface> | undefined;
  const get = () => rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return { input: process.stdin, output: process.stdout, write: (value) => process.stdout.write(value), question: async (prompt) => await get().question(prompt), close: () => rl?.close() };
}
export interface InteractiveHandlers { state(): Promise<{ active: boolean; sealed: boolean; summary: string }>; newTask(goal: string): Promise<string>; clarify(value: string): Promise<string>; command(command: string, args: string): Promise<{ message: string; quit?: boolean }>; }
export async function runInteractiveSession(io: InteractiveIo, handlers: InteractiveHandlers): Promise<void> {
  io.write("\nWeb Codex Orchestrator · v0.3\n\n");
  try {
    while (true) {
      const state = await handlers.state();
      io.write(`${state.summary}\n`);
      const raw = await io.question("\n> ");
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
  } finally { io.close(); }
}
