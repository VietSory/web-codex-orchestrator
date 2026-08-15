import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { readStableFile } from "../shared/stable-file.js";
import { WebBridgeError } from "./contracts.js";

const RELAY_TOKEN_FILE = "relay-token";
const MAX_TOKEN_CHARACTERS = 4096;
// Writer persists one trailing newline; keep the file bound consistent with the
// maximum valid token rather than making a 4096-character token unreadable.
const MAX_TOKEN_FILE_BYTES = MAX_TOKEN_CHARACTERS + 1;

function validateToken(value: string): string {
  if (value.length < 32 || value.length > MAX_TOKEN_CHARACTERS || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new WebBridgeError("WEB_RELAY_AUTH_UNAVAILABLE", "Relay credential must be 32-4096 characters without whitespace controls.");
  }
  return value;
}

async function safeCredentialsDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new WebBridgeError("WEB_RELAY_CREDENTIAL_PATH_UNSAFE", "Relay credential directory must be a canonical WCO-owned directory.");
  }
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

export function relayCredentialPath(credentialsDirectory: string): string {
  return path.join(path.resolve(credentialsDirectory), RELAY_TOKEN_FILE);
}

export async function readRelayToken(credentialsDirectory: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnvironment = env.WCO_RELAY_TOKEN;
  if (fromEnvironment) return validateToken(fromEnvironment);
  const directory = await safeCredentialsDirectory(credentialsDirectory);
  const target = path.join(directory, RELAY_TOKEN_FILE);
  try {
    const snapshot = await readStableFile(target, MAX_TOKEN_FILE_BYTES);
    return validateToken(snapshot.bytes.toString("utf8").trim());
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new WebBridgeError("WEB_RELAY_AUTH_UNAVAILABLE", "Relay credential is not configured. Run `wco web connect --self-hosted` for the advanced relay profile.");
    if (error instanceof WebBridgeError) throw error;
    throw new WebBridgeError("WEB_RELAY_CREDENTIAL_PATH_UNSAFE", `Relay credential could not be read as stable local state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeRelayToken(credentialsDirectory: string, token: string): Promise<string> {
  const value = validateToken(token);
  const directory = await safeCredentialsDirectory(credentialsDirectory);
  const target = path.join(directory, RELAY_TOKEN_FILE);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) {
    throw new WebBridgeError("WEB_RELAY_CREDENTIAL_PATH_UNSAFE", "Relay credential target is unsafe.");
  }
  const temporary = path.join(directory, `.${RELAY_TOKEN_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalCheck = await lstat(target).catch(() => null);
    if (finalCheck?.isSymbolicLink() || existing && (!finalCheck || finalCheck.dev !== existing.dev || finalCheck.ino !== existing.ino)) {
      throw new WebBridgeError("WEB_RELAY_CREDENTIAL_WRITE_CONFLICT", "Relay credential changed during atomic write.");
    }
    if (!existing && finalCheck) throw new WebBridgeError("WEB_RELAY_CREDENTIAL_WRITE_CONFLICT", "Relay credential appeared during atomic write.");
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

export async function removeRelayToken(credentialsDirectory: string): Promise<void> {
  const directory = await safeCredentialsDirectory(credentialsDirectory);
  const target = path.join(directory, RELAY_TOKEN_FILE);
  const stat = await lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(target) !== target) {
    throw new WebBridgeError("WEB_RELAY_CREDENTIAL_PATH_UNSAFE", "Relay credential target is unsafe and was preserved.");
  }
  await unlink(target);
}
