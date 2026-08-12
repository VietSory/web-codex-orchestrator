import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ConfigErrorCode, ConfigValidationReport, TrustedConfig } from "./contracts.js";
import { validateConfig } from "./config-validator.js";

export const MAXIMUM_TRUSTED_CONFIG_BYTES = 1 * 1024 * 1024;

export class ConfigError extends Error {
  constructor(readonly code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}

function hasDuplicateJsonObjectKey(source: string): boolean {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? "")) index += 1; };
  const parseString = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error("Expected JSON string");
    index += 1;
    while (index < source.length) {
      const char = source[index++];
      if (char === "\\") index += 1;
      else if (char === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const parseValue = (): boolean => {
    whitespace();
    const char = source[index];
    if (char === '"') { parseString(); return false; }
    if (char === "{") {
      index += 1; whitespace(); const keys = new Set<string>();
      if (source[index] === "}") { index += 1; return false; }
      while (index < source.length) {
        whitespace(); const key = parseString();
        if (keys.has(key)) return true;
        keys.add(key); whitespace(); if (source[index++] !== ":") throw new Error("Expected JSON colon");
        if (parseValue()) return true;
        whitespace();
        if (source[index] === "}") { index += 1; return false; }
        if (source[index++] !== ",") throw new Error("Expected JSON comma");
      }
      throw new Error("Unterminated JSON object");
    }
    if (char === "[") {
      index += 1; whitespace();
      if (source[index] === "]") { index += 1; return false; }
      while (index < source.length) {
        if (parseValue()) return true;
        whitespace();
        if (source[index] === "]") { index += 1; return false; }
        if (source[index++] !== ",") throw new Error("Expected JSON comma");
      }
      throw new Error("Unterminated JSON array");
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index += 1;
    return false;
  };
  try { return parseValue(); } catch { return false; }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function readStableConfigSource(configPath: string, initialInfo: Stats): Promise<string> {
  if (initialInfo.size > MAXIMUM_TRUSTED_CONFIG_BYTES) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Config file exceeds the ${MAXIMUM_TRUSTED_CONFIG_BYTES} byte safety limit.`,
    );
  }

  let handle;
  try {
    handle = await open(configPath, "r");
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !sameFileIdentity(initialInfo, openedInfo)) {
      throw new ConfigError("CONFIG_INVALID", "Config file changed identity before it could be read safely.");
    }
    if (openedInfo.size > MAXIMUM_TRUSTED_CONFIG_BYTES) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Config file exceeds the ${MAXIMUM_TRUSTED_CONFIG_BYTES} byte safety limit.`,
      );
    }

    const buffer = Buffer.alloc(openedInfo.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new ConfigError("CONFIG_INVALID", "Config file was truncated during read.");
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, openedInfo.size);
    if (extraBytes !== 0) throw new ConfigError("CONFIG_INVALID", "Config file grew during read.");

    const afterHandleInfo = await handle.stat();
    if (!sameFileIdentity(openedInfo, afterHandleInfo)) {
      throw new ConfigError("CONFIG_INVALID", "Config file was modified during read.");
    }
    const afterPathInfo = await lstat(configPath);
    if (afterPathInfo.isSymbolicLink() || !afterPathInfo.isFile() || !sameFileIdentity(openedInfo, afterPathInfo)) {
      throw new ConfigError("CONFIG_INVALID", "Config path changed during read.");
    }
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Config file could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * `web_native_mcp` deliberately adds no trusted URL or secret fields. Reuse the
 * mature manual-file structural validator for the rest of the config while the
 * native profile remains a local durable mailbox whose transport credentials
 * live only in owner-protected WCO credential storage.
 */
export function validateTrustedConfig(value: unknown): ConfigValidationReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return validateConfig(value);
  const root = value as Record<string, unknown>;
  const web = root.web_bridge;
  if (!web || typeof web !== "object" || Array.isArray(web) || (web as Record<string, unknown>).mode !== "web_native_mcp") return validateConfig(value);
  const item = web as Record<string, unknown>;
  const fields = Object.keys(item);
  if (fields.some((key) => !["mode", "poll_interval_ms", "job_ttl_seconds"].includes(key))) {
    return { ok: false, issues: [{ code: "CONFIG_INVALID", message: "web_native_mcp accepts only mode, poll_interval_ms, and job_ttl_seconds; OpenAI tunnel/agent credentials must stay outside trusted config." }] };
  }
  const cloned = { ...root, web_bridge: { ...item, mode: "manual_file" } };
  const report = validateConfig(cloned);
  return report.ok ? { ok: true, issues: [], config: value as TrustedConfig } : report;
}

export async function loadTrustedConfig(configPath: string): Promise<TrustedConfig> {
  let info: Stats;
  try {
    info = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("CONFIG_NOT_FOUND", `Config file does not exist: ${configPath}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new ConfigError("CONFIG_SYMLINK", "Config file must not be a symbolic link.");
  if (!info.isFile()) throw new ConfigError("CONFIG_NOT_REGULAR_FILE", "Config path must be a regular file.");
  try {
    const canonical = await realpath(configPath);
    if (canonical !== path.resolve(configPath)) throw new ConfigError("CONFIG_SYMLINK", "Config path resolves through a symbolic link.");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_INVALID", "Config file could not be resolved safely.");
  }

  let source: string;
  let parsed: unknown;
  try {
    source = await readStableConfigSource(configPath, info);
    if (hasDuplicateJsonObjectKey(source)) throw new Error("Duplicate JSON object key.");
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_INVALID", `Config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = validateTrustedConfig(parsed);
  if (!report.ok || !report.config) throw new ConfigError("CONFIG_INVALID", report.issues.map((issue) => issue.message).join(" "));
  return report.config;
}

export const loadConfig = loadTrustedConfig;