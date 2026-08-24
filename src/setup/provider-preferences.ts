import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export type WcoExecutionProvider = "chatgpt-web" | "codex";

export interface WcoProviderPreferences {
  schema_version: "1.0";
  provider: WcoExecutionProvider;
}

function validate(value: unknown): WcoProviderPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WCO_PREFERENCES_INVALID: preferences must be a JSON object.");
  const item = value as Record<string, unknown>;
  if (item.schema_version !== "1.0" || (item.provider !== "chatgpt-web" && item.provider !== "codex") || Object.keys(item).some((key) => key !== "schema_version" && key !== "provider")) {
    throw new Error("WCO_PREFERENCES_INVALID: preferences contain unsupported fields or provider values.");
  }
  return item as unknown as WcoProviderPreferences;
}

export function providerPreferencesPath(stateDirectory: string): string {
  return path.join(path.dirname(path.resolve(stateDirectory)), "preferences.json");
}

async function assertSafePreferenceFile(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("WCO_PREFERENCES_INVALID: preferences must be a regular non-symlink file.");
  if (await realpath(target) !== path.resolve(target)) throw new Error("WCO_PREFERENCES_INVALID: preferences path resolves through a symbolic link.");
}

export async function readProviderPreferences(stateDirectory: string): Promise<WcoProviderPreferences | null> {
  const target = providerPreferencesPath(stateDirectory);
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  await assertSafePreferenceFile(target);
  try {
    return validate(JSON.parse(await readFile(target, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("WCO_PREFERENCES_INVALID: preferences are not valid JSON.", { cause: error });
    throw error;
  }
}

export function readProviderPreferencesSync(stateDirectory: string): WcoProviderPreferences | null {
  const target = providerPreferencesPath(stateDirectory);
  let info;
  try { info = lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(target) !== path.resolve(target)) throw new Error("WCO_PREFERENCES_INVALID: preferences must be a regular non-symlink file.");
  try { return validate(JSON.parse(readFileSync(target, "utf8")) as unknown); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("WCO_PREFERENCES_INVALID: preferences are not valid JSON.", { cause: error });
    throw error;
  }
}

export async function writeProviderPreferences(stateDirectory: string, provider: WcoExecutionProvider): Promise<WcoProviderPreferences> {
  const target = providerPreferencesPath(stateDirectory);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw new Error("WCO_PREFERENCES_INVALID: preferences directory is unsafe.");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("WCO_PREFERENCES_INVALID: preferences target is unsafe.");

  const preferences: WcoProviderPreferences = { schema_version: "1.0", provider };
  const temporary = path.join(directory, `.preferences.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return preferences;
}

export function browserProviderSelected(stateDirectory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.WCO_CHATGPT_BROWSER?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes" || override === "on") return true;
  return readProviderPreferencesSync(stateDirectory)?.provider === "chatgpt-web";
}
