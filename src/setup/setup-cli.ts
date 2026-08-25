import readline from "node:readline/promises";
import { ChatGptBrowserAgentClient } from "../agent/chatgpt-browser-client.js";
import {
  ChatGptWebCompanionAgentClient,
  isChatGptWebCompanionConfigured,
} from "../agent/chatgpt-web-companion-client.js";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { resolveGitHubToken } from "./credential-provider.js";
import { performFirstRunSetup } from "./first-run.js";
import type { WcoExecutionProvider } from "./provider-preferences.js";

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

export interface SetupChatGptWebProviderStatus {
  value: string;
  transport: "miuuyy-helper" | "direct-browser";
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
      guidance: "Open this project from WSL and run `wco` there. This build uses Bubblewrap for deterministic filesystem/network isolation and does not start the normal setup/auth/task workflow on native Windows.",
    };
  }
  return {
    severity: "warn",
    value: `${platform} host; normal task verification requires Linux/WSL`,
    guidance: "Run WCO from a Linux/WSL environment before normal setup. This build uses Bubblewrap for deterministic filesystem/network isolation and does not start the normal setup/auth/task workflow on this native host.",
  };
}

export async function setupChatGptWebProviderStatus(
  stateDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SetupChatGptWebProviderStatus> {
  if (isChatGptWebCompanionConfigured(env)) {
    try {
      await new ChatGptWebCompanionAgentClient({ env }).checkAvailability();
      return { value: "ChatGPT Web launcher helper ready", transport: "miuuyy-helper" };
    } catch {
      return {
        value: "ChatGPT Web launcher helper sign-in/readiness pending",
        transport: "miuuyy-helper",
      };
    }
  }

  try {
    await new ChatGptBrowserAgentClient({ stateDirectory, env }).checkAvailability();
    return { value: "ChatGPT Web browser ready", transport: "direct-browser" };
  } catch {
    return { value: "ChatGPT Web browser sign-in pending", transport: "direct-browser" };
  }
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
  if (/WCO_PREFERENCES_INVALID/i.test(message)) {
    return "WCO provider preferences are invalid or unsafe. Re-run setup with an explicit provider, for example `wco setup --provider chatgpt-web --force`.";
  }
  return message;
}

function providerFromCli(value: string | undefined): WcoExecutionProvider | null {
  if (value === "chatgpt-web" || value === "codex") return value;
  return null;
}

export async function runSetupCommand(
  args: string[],
  cwd = process.cwd(),
  suppliedIo: SetupCommandIo = defaultIo,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  let yes = false, overwrite = false, configPath: string | undefined, stateDirectory: string | undefined, provider: WcoExecutionProvider | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes") yes = true;
    else if (arg === "--force") overwrite = true;
    else if (arg === "--config" || arg === "--state-dir" || arg === "--provider") {
      const value = args[++i];
      if (!value) return 2;
      if (arg === "--config") configPath = value;
      else if (arg === "--state-dir") stateDirectory = value;
      else {
        const parsed = providerFromCli(value);
        if (!parsed) {
          suppliedIo.error("Provider must be `chatgpt-web` or `codex`.\n");
          return 2;
        }
        provider = parsed;
      }
    } else {
      suppliedIo.error("Usage: wco setup [--yes] [--force] [--provider chatgpt-web|codex] [--config <path>] [--state-dir <path>]\n");
      return 2;
    }
  }

  const executionHost = setupExecutionHostStatus(platform);
  if (executionHost.severity !== "ok") {
    suppliedIo.error(`${executionHost.value}\n${executionHost.guidance ?? "Use Linux/WSL for the normal WCO workflow."}\nNo WCO setup, ChatGPT authorization, or task state was created.\n`);
    return 1;
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
    const result = await performFirstRunSetup({ cwd, ...(configPath ? { configPath } : {}), ...(stateDirectory ? { stateDirectory } : {}), overwrite, ...(provider ? { provider } : {}) });
    const checks: Array<["ok" | "warn", string, string]> = [["ok", "Git repository", result.repository.github_repository ?? result.repository.root]];
    checks.push([executionHost.severity, "Execution host", executionHost.value]);

    let providerStatus = result.provider === "chatgpt-web" ? "ChatGPT Web browser sign-in pending" : "Codex authorization pending";
    let browserTransport: SetupChatGptWebProviderStatus["transport"] | undefined;
    const explicitMode = result.config.web_bridge?.mode;
    if (!explicitMode && result.provider === "chatgpt-web") {
      const companionConfigured = isChatGptWebCompanionConfigured(process.env);
      if (companionConfigured || (process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true")) {
        const status = await setupChatGptWebProviderStatus(result.paths.state);
        providerStatus = status.value;
        browserTransport = status.transport;
      }
    } else if (!explicitMode) {
      try {
        const runtime = await resolveCodexRuntime(result.config.runtime, result.paths.state);
        await new CodexSdkAgentClient(runtime).checkAvailability();
        providerStatus = `Codex ready (${runtime.package_version})`;
      } catch { /* reported below */ }
    }

    let github = "not configured";
    if (result.config.github_pull_request) { try { await resolveGitHubToken(result.config.github_pull_request.authentication); github = "gh authenticated"; } catch { github = "gh missing or not authenticated"; } }
    checks.push([github === "gh missing or not authenticated" ? "warn" : "ok", "GitHub", github]);
    checks.push([providerStatus.includes("pending") ? "warn" : "ok", "Provider", explicitMode ? `${explicitMode} (advanced override)` : providerStatus]);
    checks.push(["ok", "PAIR review", result.provider === "chatgpt-web" && !explicitMode ? "independent ChatGPT Web review before Draft PR" : "configured provider review policy"]);

    suppliedIo.write(`\nWeb Codex Orchestrator setup\n\n${checks.map(([severity, label, value]) => `${severity === "ok" ? "✓" : "!"} ${label.padEnd(16)} ${value}`).join("\n")}\n`);
    if (!explicitMode && result.provider === "chatgpt-web") {
      suppliedIo.write("\nSetup is complete. ChatGPT Web is now the saved PAIR provider, so future terminals only need `wco` and a goal. No WCO_CHATGPT_BROWSER environment flag and no Codex model quota are required for PAIR.\n");
      if (providerStatus.includes("pending")) {
        if (browserTransport === "miuuyy-helper") {
          suppliedIo.write("Open or keep the miuuyy/codex-chatgpt-web launcher running, finish ChatGPT sign-in in its embedded browser if needed, then run `wco doctor --mode PAIR`.\n");
        } else {
          suppliedIo.write("On the next `wco` run, WCO will open its dedicated ChatGPT browser profile so you can finish sign-in if needed.\n");
        }
      }
      suppliedIo.write("Switch back later with `wco setup --provider codex`.\n");
    } else if (!explicitMode) {
      suppliedIo.write("\nSetup is complete. Codex is the saved provider. Daily use is simply `wco` and a goal. Switch to direct ChatGPT Web PAIR with `wco setup --provider chatgpt-web`.\n");
    }
    if (github === "gh missing or not authenticated") suppliedIo.write("GitHub needs attention before WCO can publish a Draft PR. Install GitHub CLI (`gh`) if it is missing, then run `gh auth login` and `wco doctor`. WCO will not start normal task execution until required readiness checks pass.\n");
    return 0;
  } catch (error) {
    suppliedIo.error(`${friendlySetupError(error)}\nYour project files and remote repository were not changed by setup.\n`);
    return 1;
  }
}
