import readline from "node:readline/promises";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { resolveGitHubToken } from "./credential-provider.js";
import { performFirstRunSetup } from "./first-run.js";

export interface SetupCommandIo {
  write(value: string): void;
  error(value: string): void;
  question?(prompt: string): Promise<string>;
}

export interface SetupExecutionHostStatus {
  severity: "ok" | "warn";
  value: string;
  guidance?: string;
}

const defaultIo: SetupCommandIo = {
  write: (value) => process.stdout.write(value),
  error: (value) => process.stderr.write(value),
};

export function setupExecutionHostStatus(platform: NodeJS.Platform = process.platform): SetupExecutionHostStatus {
  if (platform === "linux") return { severity: "ok", value: "Linux/WSL verification supported" };
  if (platform === "win32") {
    return {
      severity: "warn",
      value: "native Windows host; normal task verification requires Linux/WSL",
      guidance: "WCO can be installed from PowerShell, but the normal deterministic task workflow is not supported on native Windows by this build. Open the project from WSL and run `wco` there so Bubblewrap verification can enforce filesystem/network isolation.",
    };
  }
  return {
    severity: "warn",
    value: `${platform} host; normal task verification requires Linux/WSL`,
    guidance: "This build requires a Linux/WSL host for the normal deterministic task workflow because verification is isolated with Bubblewrap. Use a Linux environment before starting normal WCO tasks.",
  };
}

function friendlySetupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/repository root failed/i.test(message)) {
    return "WCO needs to be run inside a Git repository. `cd` into the project you want WCO to work on, then run `wco` again.";
  }
  if (/no Git remote is configured/i.test(message)) {
    return "This Git repository has no remote yet. Add the remote you want WCO to use, verify it with `git remote -v`, then run `wco` again.";
  }
  if (/fetch and push URLs differ/i.test(message)) {
    return "This repository uses different fetch and push URLs. Align the Git remote first so WCO can safely bind one repository identity, then run `wco` again.";
  }
  if (/SETUP_CHATGPT_AUTH_FAILED|ChatGPT authorization did not complete/i.test(message)) {
    return "ChatGPT authorization did not finish. Run `wco` again, or run `wco web connect` to retry the official sign-in.";
  }
  if (/SETUP_NODE_UNSUPPORTED/i.test(message)) {
    return "WCO requires Node.js 22 or newer. Update Node.js, then run `wco` again.";
  }
  return message;
}

export async function runSetupCommand(args: string[], cwd = process.cwd(), suppliedIo: SetupCommandIo = defaultIo): Promise<number> {
  let yes = false, overwrite = false, configPath: string | undefined, stateDirectory: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes") yes = true;
    else if (arg === "--force") overwrite = true;
    else if (arg === "--config" || arg === "--state-dir") {
      const value = args[++i];
      if (!value) return 2;
      if (arg === "--config") configPath = value; else stateDirectory = value;
    } else {
      suppliedIo.error("Usage: wco setup [--yes] [--force] [--config <path>] [--state-dir <path>]\n");
      return 2;
    }
  }
  if (!yes) {
    let owned: ReturnType<typeof readline.createInterface> | undefined;
    const question = suppliedIo.question ?? (process.stdin.isTTY && process.stdout.isTTY ? (() => {
      owned = readline.createInterface({ input: process.stdin, output: process.stdout });
      return async (prompt: string) => await owned!.question(prompt);
    })() : undefined);
    if (!question) {
      suppliedIo.error("Setup needs confirmation. Re-run with --yes for non-interactive setup.\n");
      return 2;
    }
    try {
      const answer = await question("Set up WCO for the current Git repository? [Y/n] ");
      if (answer && !/^y(es)?$/i.test(answer)) { suppliedIo.write("Setup cancelled.\n"); return 1; }
    } finally { owned?.close(); }
  }
  try {
    suppliedIo.write("Checking this Git repository and initial WCO setup…\n");
    const result = await performFirstRunSetup({ cwd, ...(configPath ? { configPath } : {}), ...(stateDirectory ? { stateDirectory } : {}), overwrite });
    const checks: Array<["ok" | "warn", string, string]> = [["ok", "Git repository", result.repository.github_repository ?? result.repository.root]];
    const executionHost = setupExecutionHostStatus();
    checks.push([executionHost.severity, "Execution host", executionHost.value]);
    let codex = "authorization pending";
    try { const runtime = await resolveCodexRuntime(result.config.runtime, result.paths.state); await new CodexSdkAgentClient(runtime).checkAvailability(); codex = `ChatGPT authenticated (${runtime.package_version})`; } catch { /* reported below */ }
    let github = "not configured";
    if (result.config.github_pull_request) { try { await resolveGitHubToken(result.config.github_pull_request.authentication); github = "gh authenticated"; } catch { github = "gh missing or not authenticated"; } }
    checks.push([github === "gh missing or not authenticated" ? "warn" : "ok", "GitHub", github]);
    checks.push([codex === "authorization pending" ? "warn" : "ok", "ChatGPT", codex]);
    const explicitMode = result.config.web_bridge?.mode;
    const transport = explicitMode ? `${explicitMode} (advanced override)` : "local ChatGPT/Codex";
    checks.push([explicitMode ? "warn" : "ok", "Transport", transport]);
    suppliedIo.write(`\nWeb Codex Orchestrator v0.3 setup\n\n${checks.map(([severity, label, value]) => `${severity === "ok" ? "✓" : "!"} ${label.padEnd(16)} ${value}`).join("\n")}\n`);
    if (executionHost.guidance) suppliedIo.write(`\n${executionHost.guidance}\n`);
    if (codex === "authorization pending" && !explicitMode) {
      suppliedIo.write("\nSetup is complete. On the first interactive `wco` run, the official Codex sign-in will request ChatGPT authorization if needed. No API key, relay, tunnel, domain, or cloud setup is required. WCO performs the full mode readiness check before starting a task.\n");
    } else if (!explicitMode) {
      suppliedIo.write("\nSetup is complete. Daily use is simply `wco` and a goal. WCO performs the full mode readiness check before starting a task.\n");
    }
    if (github === "gh missing or not authenticated") suppliedIo.write("GitHub needs attention before WCO can publish a Draft PR. Install GitHub CLI (`gh`) if it is missing, then run `gh auth login` and `wco doctor`. WCO will not start normal task execution until required readiness checks pass.\n");
    return 0;
  } catch (error) {
    suppliedIo.error(`${friendlySetupError(error)}\nYour project files and remote repository were not changed by setup.\n`);
    return 1;
  }
}
