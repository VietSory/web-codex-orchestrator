import { ExecutionError } from "../execution/errors.js";

export function validateExecutable(executable: unknown, allowed: readonly string[]): string {
  if (typeof executable !== "string" || !/^[A-Za-z0-9._+-]+$/.test(executable) || executable.includes("/") || executable.includes("\\") || /\s/.test(executable) || !allowed.includes(executable)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Validation executable is not allowlisted.");
  return executable;
}

export function validateArguments(executable: string, args: unknown): string[] {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && !arg.includes("\u0000"))) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", "Validation args must be NUL-free strings.");
  const values = args as string[];
  const joined = [executable, ...values].join(" ");
  if (executable === "git") {
    const subcommand = values.find((value) => !value.startsWith("-"));
    if (!subcommand || !["diff", "status", "rev-parse", "ls-files", "show"].includes(subcommand)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Only read-only Git commands are allowed.");
    if (/\b(?:push|reset|clean|commit|merge|checkout|switch|fetch|remote|branch|update-ref)\b/i.test(joined)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Git write or network operations are denied.");
  }
  if (executable === "npm" && /^(?:install|i|ci|publish|link|run\s+(?:pre|post)?install)/i.test(values.join(" ").trim())) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Network or package mutation commands are denied.");
  if (/\b(?:curl|wget|gh|ssh|scp|nc|telnet|docker|kubectl)\b/i.test(executable)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Network-capable executable is denied.");
  return values;
}
