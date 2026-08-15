export const SLASH_COMMANDS = [
  ["/new", "PAIR: collaborate on a task and add details before the plan locks: /new <goal>"],
  ["/auto", "AUTOPILOT: run end-to-end unless a decision needs you: /auto <goal>"],
  ["/continue", "Continue the current task, or the most recent safely resumable task"],
  ["/resume", "Choose a saved task to resume; /resume <number> resumes a history item"],
  ["/status", "Show current progress and what you need to do"],
  ["/review", "Show checks, review, and Draft PR evidence"],
  ["/history", "Show recent tasks; /history <number> shows details"],
  ["/pause", "Pause before the next safe step"],
  ["/task", "Show the current goal and plan state"],
  ["/auth status", "Show ChatGPT authorization status"],
  ["/auth connect", "Authorize or reconnect ChatGPT"],
  ["/doctor", "Check whether WCO is ready to complete the current mode"],
  ["/uninstall", "Remove WCO-owned local resources and WCO"],
  ["/help", "Show normal workflow commands"],
  ["/quit", "Exit WCO safely"],
] as const;

export type SlashCommandName = typeof SLASH_COMMANDS[number][0];
export interface SlashCommandSuggestion { command: SlashCommandName; description: string; }

/**
 * Legacy spellings and advanced subcommands remain accepted by the parser,
 * but are intentionally absent from the normal-user palette. This preserves
 * compatibility without making first-time command discovery noisy.
 */
export function canonicalSlashCommand(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/unitsall" || trimmed.startsWith("/unitsall ")) return `/uninstall${trimmed.slice(9)}`;
  if (trimmed === "/auth" || trimmed.startsWith("/auth ")) return `/web${trimmed.slice(5)}`;
  return trimmed;
}

function commandAllowed(command: SlashCommandName, allowedCommands?: ReadonlySet<string>): boolean {
  return !allowedCommands || allowedCommands.has(command);
}

export function slashCommandSuggestions(value: string, allowedCommands?: ReadonlySet<string>): SlashCommandSuggestion[] {
  const input = value.trimStart().toLowerCase();
  if (!input.startsWith("/")) return [];
  return SLASH_COMMANDS
    .filter(([command]) => commandAllowed(command, allowedCommands) && command.toLowerCase().startsWith(input))
    .map(([command, description]) => ({ command, description }));
}

export function parseInteractiveInput(value: string, state: { active: boolean; sealed: boolean }): { kind: "empty" | "command" | "new" | "clarification" | "sealed_block"; command?: string; args?: string; goal?: string } {
  const input = canonicalSlashCommand(value);
  if (!input) return { kind: "empty" };
  if (input.startsWith("/")) {
    const space = input.indexOf(" ");
    return { kind: "command", command: space < 0 ? input : input.slice(0, space), args: space < 0 ? "" : input.slice(space + 1).trim() };
  }
  if (!state.active) return { kind: "new", goal: input };
  if (!state.sealed) return { kind: "clarification", goal: input };
  return { kind: "sealed_block", goal: input };
}

export function commandPalette(allowedCommands?: ReadonlySet<string>): string {
  return SLASH_COMMANDS
    .filter(([command]) => commandAllowed(command, allowedCommands))
    .map(([command, description]) => `${command.padEnd(16)} ${description}`)
    .join("\n");
}
