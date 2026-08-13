import { spawn } from "node:child_process";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./codex-runtime.js";

function run(runtime: ResolvedCodexRuntime, args: string[], stdio: "ignore" | "inherit"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, [...runtime.prefix_args, ...args], {
      cwd: runtime.launcher_directory,
      env: runtime.environment,
      shell: false,
      stdio,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function loggedIn(runtime: ResolvedCodexRuntime): Promise<boolean> {
  try { return await run(runtime, ["login", "status"], "ignore") === 0; }
  catch { return false; }
}

/**
 * WCO never reads or stores ChatGPT OAuth credentials. The bundled official
 * Codex runtime owns the browser callback, token storage and refresh lifecycle.
 * Non-interactive callers never start a browser flow and simply observe false.
 */
export async function ensureChatGptLogin(options: {
  config: TrustedConfig;
  stateDirectory: string;
  interactive?: boolean;
}): Promise<boolean> {
  const runtime = await resolveCodexRuntime(options.config.runtime, options.stateDirectory);
  if (await loggedIn(runtime)) return true;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || process.env.CI === "true") return false;
  const exitCode = await run(runtime, ["login"], "inherit");
  return exitCode === 0 && await loggedIn(runtime);
}
