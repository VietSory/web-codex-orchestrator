import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ConfigErrorCode, TrustedConfig } from "./contracts.js";
import { validateConfig } from "./config-validator.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

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

async function readStableConfig(configPath: string, pathBefore: Stats): Promise<Buffer> {
  if (pathBefore.size > MAX_CONFIG_BYTES) throw new ConfigError("CONFIG_INVALID", `Config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(configPath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new ConfigError("CONFIG_INVALID", `Config file could not be opened safely: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_CONFIG_BYTES) {
      throw new ConfigError("CONFIG_INVALID", "Config file changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ConfigError("CONFIG_INVALID", "Config file was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new ConfigError("CONFIG_INVALID", "Config file grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(configPath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new ConfigError("CONFIG_INVALID", "Config file changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function loadTrustedConfig(configPath: string): Promise<TrustedConfig> {
  const resolved = path.resolve(configPath);
  let info: Stats;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("CONFIG_NOT_FOUND", `Config file does not exist: ${configPath}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new ConfigError("CONFIG_SYMLINK", "Config file must not be a symbolic link.");
  if (!info.isFile()) throw new ConfigError("CONFIG_NOT_REGULAR_FILE", "Config path must be a regular file.");
  try {
    const canonical = await realpath(resolved);
    if (canonical !== resolved) throw new ConfigError("CONFIG_SYMLINK", "Config path resolves through a symbolic link.");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_INVALID", "Config file could not be resolved safely.");
  }
  let source: string;
  let parsed: unknown;
  try {
    source = (await readStableConfig(resolved, info)).toString("utf8");
    if (hasDuplicateJsonObjectKey(source)) throw new Error("Duplicate JSON object key.");
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CONFIG_INVALID", `Config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = validateConfig(parsed);
  if (!report.ok || !report.config) throw new ConfigError("CONFIG_INVALID", report.issues.map((issue) => issue.message).join(" "));
  return report.config;
}

export const loadConfig = loadTrustedConfig;
