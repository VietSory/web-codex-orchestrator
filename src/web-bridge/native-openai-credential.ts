import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { WebBridgeError } from "./contracts.js";

const FILE = "openai-web-native.json";
// Official Secure MCP Tunnel onboarding currently defines tunnel IDs as
// `tunnel_` followed by exactly 32 lowercase hexadecimal characters.
const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
const TRIGGER_ID = /^agtch_[A-Za-z0-9_-]{3,128}$/;

export interface NativeOpenAiCredential {
  schema_version: "1.0";
  tunnel_id: string;
  control_plane_api_key: string;
  workspace_agent_trigger_id: string;
  workspace_agent_access_token: string;
}

function secret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096 || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_INVALID", `${label} is invalid.`);
  }
  return value;
}

function parse(value: unknown): NativeOpenAiCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_INVALID", "OpenAI Web-native credential must be an object.");
  const item = value as Record<string, unknown>;
  const allowed = ["schema_version", "tunnel_id", "control_plane_api_key", "workspace_agent_trigger_id", "workspace_agent_access_token"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) || item.schema_version !== "1.0") throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_INVALID", "OpenAI Web-native credential schema is invalid.");
  const tunnelId = secret(item.tunnel_id, "tunnel_id");
  const triggerId = secret(item.workspace_agent_trigger_id, "workspace_agent_trigger_id");
  if (!TUNNEL_ID.test(tunnelId)) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_INVALID", "tunnel_id is invalid.");
  if (!TRIGGER_ID.test(triggerId)) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_INVALID", "Workspace Agent API trigger id is invalid.");
  return {
    schema_version: "1.0",
    tunnel_id: tunnelId,
    control_plane_api_key: secret(item.control_plane_api_key, "control_plane_api_key"),
    workspace_agent_trigger_id: triggerId,
    workspace_agent_access_token: secret(item.workspace_agent_access_token, "workspace_agent_access_token"),
  };
}

async function safeDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_PATH_UNSAFE", "WCO credential directory must be a canonical non-symlink directory.");
  }
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

export function nativeOpenAiCredentialPath(credentialsDirectory: string): string {
  return path.join(path.resolve(credentialsDirectory), FILE);
}

export async function writeNativeOpenAiCredential(credentialsDirectory: string, input: NativeOpenAiCredential): Promise<string> {
  const value = parse(input);
  const directory = await safeDirectory(credentialsDirectory);
  const target = path.join(directory, FILE);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_PATH_UNSAFE", "WCO native credential target is unsafe.");
  const temporary = path.join(directory, `.${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalCheck = await lstat(target).catch(() => null);
    if (finalCheck?.isSymbolicLink() || existing && (!finalCheck || finalCheck.dev !== existing.dev || finalCheck.ino !== existing.ino) || !existing && finalCheck) {
      throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_WRITE_CONFLICT", "WCO native credential changed during atomic write.");
    }
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
    const parent = await open(directory, fsConstants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    return target;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readNativeOpenAiCredential(credentialsDirectory: string): Promise<NativeOpenAiCredential> {
  const directory = await safeDirectory(credentialsDirectory);
  const target = path.join(directory, FILE);
  const stat = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebBridgeError("WEB_NATIVE_SETUP_REQUIRED", "OpenAI Web-native authorization is not configured. Run `wco web connect`.");
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || await realpath(target) !== target) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_PATH_UNSAFE", "WCO native credential file is unsafe.");
  return parse(JSON.parse(await readFile(target, "utf8")) as unknown);
}

export async function removeNativeOpenAiCredential(credentialsDirectory: string): Promise<void> {
  const directory = await safeDirectory(credentialsDirectory);
  const target = path.join(directory, FILE);
  const stat = await lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(target) !== target) throw new WebBridgeError("WEB_NATIVE_CREDENTIAL_PATH_UNSAFE", "Unsafe native credential was preserved.");
  await unlink(target);
}
