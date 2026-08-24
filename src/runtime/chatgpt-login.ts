import { spawn } from "node:child_process";
import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";
import { browserProviderSelected } from "../setup/provider-preferences.js";
import { resolveCodexRuntime, type ResolvedCodexRuntime } from "./codex-runtime.js";

export type ChatGptLoginRunner = (
  runtime: ResolvedCodexRuntime,
  args: string[],
  stdio: "ignore" | "inherit",
) => Promise<number>;

type ChatGptLoginInput = Pick<NodeJS.ReadStream, "isTTY" | "isRaw" | "pause">;
type ChatGptLoginOutput = Pick<NodeJS.WriteStream, "isTTY">;

// Positive authorization evidence is process-local only. It never stores or
// parses OAuth credentials. Reusing it avoids launching `codex login status`
// before every semantic turn in the same WCO process. Actual provider calls
// still fail closed if authorization is revoked after this preflight.
const positiveLoginProof = new Set<string>();

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

function loginProofKey(runtime: ResolvedCodexRuntime): string {
  return JSON.stringify([
    runtime.launcher_path,
    runtime.package_version,
    runtime.state_directory ?? "",
    runtime.environment.HOME ?? "",
    runtime.environment.USERPROFILE ?? "",
  ]);
}

async function loggedIn(runtime: ResolvedCodexRuntime, execute: ChatGptLoginRunner): Promise<boolean> {
  try { return await execute(runtime, ["login", "status"], "ignore") === 0; }
  catch { return false; }
}

/** The official login flow may inherit stdin only when no raw-mode UI owns it. */
export function chatGptLoginCanOwnTerminal(
  input: Pick<NodeJS.ReadStream, "isTTY" | "isRaw"> = process.stdin,
  output: ChatGptLoginOutput = process.stdout,
): boolean {
  return Boolean(input.isTTY && output.isTTY && input.isRaw !== true);
}

/**
 * Stop the parent Node stream from consuming terminal input before the bundled
 * Codex child inherits the same stdin file descriptor. This also covers a
 * completed readline question whose interface is still alive but no longer
 * owns the next interaction. The next WCO prompt explicitly resumes stdin when
 * it takes ownership again.
 */
export function releaseParentInputForChatGptLogin(input: ChatGptLoginInput = process.stdin): void {
  if (input.isTTY && input.isRaw !== true) input.pause();
}

/** Test/support hook: production code does not need to invalidate positive proof. */
export function clearProcessChatGptLoginProof(): void {
  positiveLoginProof.clear();
}

/**
 * WCO never reads or stores ChatGPT OAuth credentials. The bundled official
 * Codex runtime owns the browser callback, token storage and refresh lifecycle.
 * Non-interactive callers never start a browser flow and simply observe false.
 * A raw-mode parent TUI also counts as non-interactive so two terminal readers
 * can never compete for stdin. Before an inherited interactive login, the
 * parent stream is paused so a completed readline prompt cannot compete either.
 *
 * Direct ChatGPT Web PAIR does not use the Codex runtime for provider turns or
 * authorization. Its dedicated browser profile owns its own ChatGPT session,
 * so this legacy Codex authorization preflight becomes a no-op in that mode.
 *
 * A successful production status/login check is remembered only for this Node
 * process. `forceStatus` bypasses that optimization for explicit reconnect
 * operations. Test runners also bypass the cache so command-call assertions
 * remain deterministic and isolated.
 */
export async function ensureChatGptLogin(options: {
  config: TrustedConfig;
  stateDirectory: string;
  interactive?: boolean;
  forceStatus?: boolean;
  /** Test seams only; production callers use process stdio and bundled runtime. */
  input?: ChatGptLoginInput;
  output?: ChatGptLoginOutput;
  runCommand?: ChatGptLoginRunner;
}): Promise<boolean> {
  if (browserProviderSelected(options.stateDirectory)) return true;

  const runtime = await resolveCodexRuntime(options.config.runtime, options.stateDirectory);
  const execute = options.runCommand ?? run;
  const productionRunner = options.runCommand === undefined;
  const proofKey = loginProofKey(runtime);
  if (productionRunner && !options.forceStatus && positiveLoginProof.has(proofKey)) return true;

  if (await loggedIn(runtime, execute)) {
    if (productionRunner) positiveLoginProof.add(proofKey);
    return true;
  }
  if (productionRunner) positiveLoginProof.delete(proofKey);

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = options.interactive ?? chatGptLoginCanOwnTerminal(input, output);
  if (!interactive || process.env.CI === "true") return false;
  releaseParentInputForChatGptLogin(input);
  const exitCode = await execute(runtime, ["login"], "inherit");
  const verified = exitCode === 0 && await loggedIn(runtime, execute);
  if (productionRunner && verified) positiveLoginProof.add(proofKey);
  return verified;
}
