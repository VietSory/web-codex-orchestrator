import { realpath, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";

const moduleRequire = createRequire(import.meta.url);

export const PINNED_CODEX_CLI_VERSION = "0.145.0";

export interface TrustedCodexRuntimeConfig {
  source: "bundled";
  codex_home?: string;
}

export interface ResolvedCodexRuntime {
  /** Process executable used to launch the Codex JavaScript launcher. */
  executable: string;
  /** Arguments that must appear before Codex CLI arguments. */
  prefix_args: string[];
  /** Optional explicit SDK native binary override for tests only. */
  sdk_codex_path_override?: string;
  environment: Record<string, string>;
  state_directory?: string;
  source: "bundled";
  package_version: string;
  launcher_path: string;
}

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

interface CodexPackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

function executionError(
  code: "CODEX_RUNTIME_NOT_FOUND" | "CODEX_RUNTIME_VERSION_MISMATCH",
  message: string,
): ExecutionError {
  return new ExecutionError(code, message);
}

function assertAbsoluteCodexHome(value: string): void {
  if (!path.isAbsolute(value) || value.includes("\u0000")) {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      "The trusted Codex home must be an absolute NUL-free path.",
    );
  }
}

async function resolveBundledCodexLauncher(): Promise<{
  packageVersion: string;
  launcherPath: string;
}> {
  let packageJsonPath: string;

  try {
    packageJsonPath = moduleRequire.resolve("@openai/codex/package.json");
  } catch {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      "The bundled @openai/codex package could not be resolved.",
    );
  }

  let manifest: CodexPackageManifest;

  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as CodexPackageManifest;
  } catch {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      "The bundled @openai/codex package manifest is invalid.",
    );
  }

  if (manifest.name !== "@openai/codex" || typeof manifest.version !== "string") {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      "The resolved Codex package is not @openai/codex.",
    );
  }

  if (manifest.version !== PINNED_CODEX_CLI_VERSION) {
    throw executionError(
      "CODEX_RUNTIME_VERSION_MISMATCH",
      `The bundled Codex package must be ${PINNED_CODEX_CLI_VERSION}.`,
    );
  }

  const launcherPath = path.join(path.dirname(packageJsonPath), "bin", "codex.js");
  let canonicalLauncher: string;

  try {
    canonicalLauncher = await realpath(launcherPath);
    const launcherInfo = await stat(canonicalLauncher);
    if (!launcherInfo.isFile()) throw new Error("Launcher is not a regular file.");
  } catch {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      "The bundled Codex launcher is unavailable.",
    );
  }

  return { packageVersion: manifest.version, launcherPath: canonicalLauncher };
}

export function detectCodexCliVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

export function assertCompatibleCodexCliVersion(output: string): string {
  const detected = detectCodexCliVersion(output);
  if (detected !== PINNED_CODEX_CLI_VERSION) {
    throw executionError(
      "CODEX_RUNTIME_VERSION_MISMATCH",
      `The Codex CLI must be exactly ${PINNED_CODEX_CLI_VERSION}.`,
    );
  }
  return detected;
}

export async function resolveCodexRuntime(
  config: TrustedCodexRuntimeConfig | undefined,
  stateDirectory?: string,
): Promise<ResolvedCodexRuntime> {
  if (!config || config.source !== "bundled") {
    throw executionError(
      "CODEX_RUNTIME_NOT_FOUND",
      'The trusted Codex runtime source must be "bundled".',
    );
  }

  if (config.codex_home !== undefined) {
    if (typeof config.codex_home !== "string") {
      throw executionError("CODEX_RUNTIME_NOT_FOUND", "The trusted Codex home is invalid.");
    }
    assertAbsoluteCodexHome(config.codex_home);
  }

  const bundled = await resolveBundledCodexLauncher();
  const environment: Record<string, string> = {};

  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined && !value.includes("\u0000")) environment[key] = value;
  }
  if (config.codex_home !== undefined) environment.CODEX_HOME = config.codex_home;

  return {
    executable: process.execPath,
    prefix_args: [bundled.launcherPath],
    environment,
    source: "bundled",
    package_version: bundled.packageVersion,
    launcher_path: bundled.launcherPath,
    ...(stateDirectory ? { state_directory: path.resolve(stateDirectory) } : {}),
  };
}

export function codexCliArgs(runtime: ResolvedCodexRuntime, args: readonly string[]): string[] {
  return [...runtime.prefix_args, ...args];
}

export function minimalCodexEnvironment(runtime: ResolvedCodexRuntime): Record<string, string> {
  const allowed = new Set<string>([...INHERITED_ENVIRONMENT_KEYS, "CODEX_HOME"]);
  return Object.fromEntries(Object.entries(runtime.environment).filter(([key]) => allowed.has(key)));
}
