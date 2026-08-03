import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";

export interface TrustedCodexRuntimeConfig {
  codex_executable: string;
  codex_home?: string;
}

export interface ResolvedCodexRuntime {
  executable: string;
  environment: Record<string, string>;
  /** State root used for the verifier smoke-test directory. */
  state_directory?: string;
}

export const PINNED_CODEX_CLI_VERSION = "0.145.0";

export function detectCodexCliVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

export function assertCompatibleCodexCliVersion(output: string): string {
  const detected = detectCodexCliVersion(output);
  if (detected !== PINNED_CODEX_CLI_VERSION) {
    throw new ExecutionError("CODEX_RUNTIME_VERSION_MISMATCH", "The Codex CLI version does not match the pinned 0.145.0 runtime contract.");
  }
  return detected;
}

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
] as const;

export async function resolveCodexRuntime(config: TrustedCodexRuntimeConfig | undefined, stateDirectory?: string): Promise<ResolvedCodexRuntime> {
  if (!config || typeof config.codex_executable !== "string" || !path.isAbsolute(config.codex_executable) || config.codex_executable.includes("\u0000")) {
    throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "The trusted Codex executable is not configured.");
  }
  if (config.codex_home !== undefined && (typeof config.codex_home !== "string" || !path.isAbsolute(config.codex_home) || config.codex_home.includes("\u0000"))) {
    throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "The trusted Codex home is invalid.");
  }
  let executable: string;
  try {
    executable = await realpath(config.codex_executable);
    const info = await stat(executable);
    if (!info.isFile()) throw new Error("Codex executable is not a regular file.");
  } catch {
    throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "The trusted Codex executable is unavailable.");
  }

  const environment: Record<string, string> = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined && !value.includes("\u0000")) environment[key] = value;
  }
  if (config.codex_home !== undefined) environment.CODEX_HOME = config.codex_home;
  return {
    executable,
    environment,
    ...(stateDirectory ? { state_directory: path.resolve(stateDirectory) } : {}),
  };
}

export function minimalCodexEnvironment(runtime: ResolvedCodexRuntime): Record<string, string> {
  const allowed = new Set<string>([...INHERITED_ENVIRONMENT_KEYS, "CODEX_HOME"]);
  return Object.fromEntries(Object.entries(runtime.environment).filter(([key]) => allowed.has(key)));
}
