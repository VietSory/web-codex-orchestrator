import { chmod, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../run/run-store.js";
import { WebBridgeError } from "./contracts.js";

const CREDENTIAL_FILE = "managed-device.json";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_CONTROL = /[\r\n\0]/;

export interface ManagedDeviceCredential {
  schema_version: "1.0";
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_id: string;
  device_id: string;
  scopes: string[];
}

function safeToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || value !== value.trim() || TOKEN_CONTROL.test(value)) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", `${label} is invalid.`);
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", `${label} is invalid.`);
  return value;
}

export function parseManagedDeviceCredential(value: unknown): ManagedDeviceCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", "Managed device credential must be an object.");
  const raw = value as Record<string, unknown>;
  const keys = ["schema_version", "token_type", "access_token", "refresh_token", "expires_at", "account_id", "device_id", "scopes"];
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", `Managed device credential contains unknown field '${key}'.`);
  for (const key of keys) if (!(key in raw)) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", `Managed device credential is missing '${key}'.`);
  if (raw.schema_version !== "1.0" || raw.token_type !== "Bearer") throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", "Managed device credential version/token type is invalid.");
  if (typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at))) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", "Managed credential expiry is invalid.");
  if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 16 || raw.scopes.some((scope) => typeof scope !== "string" || !/^[a-z][a-z0-9.:-]{0,63}$/.test(scope))) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", "Managed credential scopes are invalid.");
  return {
    schema_version: "1.0",
    token_type: "Bearer",
    access_token: safeToken(raw.access_token, "access_token"),
    refresh_token: safeToken(raw.refresh_token, "refresh_token"),
    expires_at: raw.expires_at,
    account_id: safeIdentifier(raw.account_id, "account_id"),
    device_id: safeIdentifier(raw.device_id, "device_id"),
    scopes: [...new Set(raw.scopes as string[])].sort(),
  };
}

async function safeCredentialDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_PATH_UNSAFE", "Managed credential directory must be canonical and WCO-owned.");
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

export function managedCredentialPath(credentialsDirectory: string): string { return path.join(path.resolve(credentialsDirectory), CREDENTIAL_FILE); }

export async function readManagedDeviceCredential(credentialsDirectory: string): Promise<ManagedDeviceCredential> {
  const target = path.join(await safeCredentialDirectory(credentialsDirectory), CREDENTIAL_FILE);
  let stat;
  try { stat = await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebBridgeError("WEB_MANAGED_RECONNECT_REQUIRED", "WCO device authorization is not linked.");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || await realpath(target) !== target || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_PATH_UNSAFE", "Managed credential file is unsafe or has permissive permissions.");
  try { return parseManagedDeviceCredential(JSON.parse(await readFile(target, "utf8"))); }
  catch (error) { if (error instanceof WebBridgeError) throw error; throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_INVALID", "Managed credential JSON is invalid."); }
}

export async function writeManagedDeviceCredential(credentialsDirectory: string, credential: ManagedDeviceCredential): Promise<string> {
  const value = parseManagedDeviceCredential(credential);
  const directory = await safeCredentialDirectory(credentialsDirectory);
  const target = path.join(directory, CREDENTIAL_FILE);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_PATH_UNSAFE", "Managed credential target is unsafe.");
  await atomicWriteJson(target, value);
  await chmod(target, 0o600).catch(() => undefined);
  return target;
}

export async function removeManagedDeviceCredential(credentialsDirectory: string): Promise<void> {
  const target = path.join(await safeCredentialDirectory(credentialsDirectory), CREDENTIAL_FILE);
  const stat = await lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(target) !== target) throw new WebBridgeError("WEB_MANAGED_CREDENTIAL_PATH_UNSAFE", "Managed credential target is unsafe and was preserved.");
  await unlink(target);
}
