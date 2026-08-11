export const SLASH_COMMANDS = [
  ["/new", "Start a new task"],
  ["/auto", "Start an AUTOPILOT task: /auto <goal>"],
  ["/status", "Current task and workflow progress"],
  ["/task", "View current goal/contract summary"],
  ["/run", "Start or continue the workflow"],
  ["/web status", "Show Web Architect connection and pending work"],
  ["/web connect", "Connect the managed WCO Senior Architect"],
  ["/web open", "Open the WCO Senior Architect GPT"],
  ["/web disconnect", "Remove the locally stored Web credential"],
  ["/review", "Latest reviews, Result Bundle and Draft PR"],
  ["/pause", "Pause before the next safe transition"],
  ["/resume", "Clear an explicit pause and continue"],
  ["/history", "Previous WCO runs for this repository"],
  ["/config", "View user-facing settings"],
  ["/config web", "Reconnect the managed Web Architect"],
  ["/doctor", "Diagnose local environment"],
  ["/uninstall", "Remove WCO-owned local resources and WCO itself"],
  ["/unitsall", "Alias for /uninstall"],
  ["/help", "Command help"],
  ["/quit", "Exit WCO"],
] as const;
export type SlashCommandName = typeof SLASH_COMMANDS[number][0];
export function canonicalSlashCommand(value: string): string { const trimmed = value.trim(); return trimmed === "/unitsall" || trimmed.startsWith("/unitsall ") ? `/uninstall${trimmed.slice(9)}` : trimmed; }
export function parseInteractiveInput(value: string, state: { active: boolean; sealed: boolean }): { kind: "empty" | "command" | "new" | "clarification" | "sealed_block"; command?: string; args?: string; goal?: string } {
  const input = canonicalSlashCommand(value);
  if (!input) return { kind: "empty" };
  if (input.startsWith("/")) { const space = input.indexOf(" "); return { kind: "command", command: space < 0 ? input : input.slice(0, space), args: space < 0 ? "" : input.slice(space + 1).trim() }; }
  if (!state.active) return { kind: "new", goal: input };
  if (!state.sealed) return { kind: "clarification", goal: input };
  return { kind: "sealed_block", goal: input };
}
export function commandPalette(): string { return SLASH_COMMANDS.map(([command, description]) => `${command.padEnd(12)} ${description}`).join("\n"); }
