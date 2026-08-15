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

const defaultIo: SetupCommandIo = {
  write: (value) => process.stdout.write(value),
  error: (value) => process.stderr.write(value),
};

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
    const result = await performFirstRunSetup({ cwd, ...(configPath ? { configPath } : {}), ...(stateDirectory ? { stateDirectory } : {}), overwrite });
    const checks: Array<["ok" | "warn", string, string]> = [["ok", "Git repository", result.repository.github_repository ?? result.repository.root]];
    let codex = "authorization pending";
    try { const runtime = await resolveCodexRuntime(result.config.runtime, result.paths.state); await new CodexSdkAgentClient(runtime).checkAvailability(); codex = `ChatGPT authenticated (${runtime.package_version})`; } catch { /* reported below */ }
    let github = "not configured";
    if (result.config.github_pull_request) { try { await resolveGitHubToken(result.config.github_pull_request.authentication); github = "gh authenticated"; } catch { github = "authentication unavailable"; } }
    checks.push([github === "authentication unavailable" ? "warn" : "ok", "GitHub", github]);
    checks.push([codex === "authorization pending" ? "warn" : "ok", "Codex", codex]);
    const explicitMode = result.config.web_bridge?.mode;
    const transport = explicitMode ? `${explicitMode} (advanced override)` : "local ChatGPT/Codex (zero-config default)";
    checks.push([explicitMode ? "warn" : "ok", "Web transport", transport]);
    suppliedIo.write(`\nWeb Codex Orchestrator v0.3 setup\n\n${checks.map(([severity, label, value]) => `${severity === "ok" ? "✓" : "!"} ${label.padEnd(16)} ${value}`).join("\n")}\n`);
    if (codex === "authorization pending" && !explicitMode) {
      suppliedIo.write("\nSetup is complete. On the first interactive `wco` run, the bundled official Codex runtime will request one ChatGPT browser authorization. WCO does not require an API key, tunnel, MCP connector, relay, domain, VPS, Cloudflare, ngrok, or copied browser credential.\n");
    } else if (!explicitMode) {
      suppliedIo.write("\nSetup is complete. ChatGPT authorization is ready; daily use is simply `wco` and a goal. No per-task browser setup is required.\n");
    }
    if (github === "authentication unavailable") suppliedIo.write("GitHub authentication needs attention before Draft PR publication. Run `gh auth login`, then `wco doctor`.\n");
    return 0;
  } catch (error) {
    suppliedIo.error(`${error instanceof Error ? error.message : String(error)}\nNo repository files or remote resources were changed.\n`);
    return 1;
  }
}
