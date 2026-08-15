import { spawn } from "node:child_process";
import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./codex-runtime.js";

export type ChatGptLoginRunner = (
  runtime: ResolvedCodexRuntime,
  args: string[],
  stdio: "ignore" | "inherit",
) => Promise<number>;

const run: ChatGptLoginRunner = (runtime, args, stdio) => {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, [...runtime.prefix_args, ...args], {
      cwd: path.dirname(runtime.launcher_path),
      env: runtime.environment,
      shell: false,
      stdio,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
};

async function loggedIn(runtime: ResolvedCodexRuntime, execute: ChatGptLoginRunner): Promise<boolean> {
  try { return await execute(runtime, ["login", "status"], "ignore") === 0; }
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
  /** Test seam only; production callers always use the bundled runtime runner. */
  runCommand?: ChatGptLoginRunner;
}): Promise<boolean> {
  const runtime = await resolveCodexRuntime(options.config.runtime, options.stateDirectory);
  const execute = options.runCommand ?? run;
  if (await loggedIn(runtime, execute)) return true;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || process.env.CI === "true") return false;
  const exitCode = await execute(runtime, ["login"], "inherit");
  return exitCode === 0 && await loggedIn(runtime, execute);
}
