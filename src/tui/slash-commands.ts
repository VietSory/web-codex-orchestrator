export const SLASH_COMMANDS = [
  ["/new", "Start a new PAIR task: /new <goal>"],
  ["/auto", "Start an AUTOPILOT task: /auto <goal>"],
  ["/status", "Show current progress and next action"],
  ["/run", "Continue the current task"],
  ["/review", "Show checks, review, and Draft PR"],
  ["/history", "Show recent tasks in this repository"],
  ["/pause", "Pause before the next safe step"],
  ["/resume", "Resume a paused task"],
  ["/task", "Show the current goal and plan state"],
  ["/mode", "AUTOPILOT reviewer: /mode <sol|terra> <effort>"],
  ["/web status", "Show ChatGPT authorization status"],
  ["/web connect", "Authorize or reconnect ChatGPT"],
  ["/doctor", "Check local prerequisites and authorization"],
  ["/config", "Show WCO settings"],
  ["/uninstall", "Remove WCO-owned local resources and WCO"],
  ["/help", "Show command help"],
  ["/quit", "Exit WCO"],
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
  return trimmed === "/unitsall" || trimmed.startsWith("/unitsall ") ? `/uninstall${trimmed.slice(9)}` : trimmed;
}

export function slashCommandSuggestions(value: string): SlashCommandSuggestion[] {
  const input = value.trimStart().toLowerCase();
  if (!input.startsWith("/")) return [];
  return SLASH_COMMANDS
    .filter(([command]) => command.toLowerCase().startsWith(input))
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

export function commandPalette(): string {
  return SLASH_COMMANDS.map(([command, description]) => `${command.padEnd(16)} ${description}`).join("\n");
}
