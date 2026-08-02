import { ExecutionError } from "../execution/errors.js";

export function validateExecutable(executable: unknown, allowed: readonly string[]): string {
  if (typeof executable !== "string" || !/^[A-Za-z0-9._+-]+$/.test(executable) || executable.includes("/") || executable.includes("\\") || /\s/.test(executable) || !allowed.includes(executable)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Validation executable is not allowlisted.");
  return executable;
}

export function validateArguments(executable: string, args: unknown): string[] {
  if (!Array.isArray(args) || args.length > 256 || !args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\u0000"))) throw new ExecutionError("VALIDATION_CONTRACT_INVALID", "Validation args must be bounded NUL-free strings.");
  const values = args as string[];
  const joined = [executable, ...values].join(" ");
  if (executable === "git") {
    const subcommand = values.find((value) => !value.startsWith("-"));
    if (!subcommand || !["diff", "status", "rev-parse", "ls-files", "show"].includes(subcommand)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Only read-only Git commands are allowed.");
    if (values.some((value) => value === "-c" || value === "--config-env" || value === "--ext-diff" || value === "--textconv" || value === "--no-index" || value === "--output" || value.startsWith("--output=") || value === "--git-dir" || value.startsWith("--git-dir=") || value === "--work-tree" || value.startsWith("--work-tree=") || value === "--exec-path" || value.startsWith("--exec-path="))) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Git configuration, external helpers, and out-of-root paths are denied.");
    if (/\b(?:push|reset|clean|commit|merge|checkout|switch|fetch|remote|branch|update-ref)\b/i.test(joined)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Git write or network operations are denied.");
  }
  if (executable === "npm") {
    const subcommandIndex = values.findIndex((value) => !value.startsWith("-"));
    const subcommand = subcommandIndex >= 0 ? values[subcommandIndex]!.toLowerCase() : "";
    const denied = new Set([
      "install", "i", "ci", "publish", "link", "uninstall", "update", "exec", "x", "dlx",
      "view", "search", "audit", "outdated", "fund", "pack", "config", "root", "repo", "docs",
      "bugs", "access", "dist-tag", "deprecate", "owner", "profile", "token", "login", "logout", "whoami",
    ]);
    if (denied.has(subcommand)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Network or package mutation commands are denied.");
    if (values.some((value) => value === "-g" || value === "--global" || value === "--prefix" || value === "--location=global" || value.startsWith("--prefix="))) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Global or out-of-root npm execution is denied.");
    if (subcommand === "run") {
      const script = values[subcommandIndex + 1]?.toLowerCase() ?? "";
      if (/^(?:pre|post)?(?:install|publish|pack|prepare|version)$/.test(script)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Lifecycle and package publishing scripts are denied.");
    }
  }
  if (/\b(?:sh|bash|dash|zsh|cmd|powershell|pwsh|curl|wget|gh|ssh|scp|nc|telnet|docker|podman|kubectl|helm|terraform|tofu)\b/i.test(executable)) throw new ExecutionError("VALIDATION_EXECUTABLE_DENIED", "Shell or network-capable executable is denied.");
  return values;
}
