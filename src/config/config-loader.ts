import { lstat, readFile } from "node:fs/promises";
import type { ConfigErrorCode, TrustedConfig } from "./contracts.js";
import { validateConfig } from "./config-validator.js";

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

export async function loadTrustedConfig(configPath: string): Promise<TrustedConfig> {
  let info;
  try {
    info = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("CONFIG_NOT_FOUND", `Config file does not exist: ${configPath}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new ConfigError("CONFIG_SYMLINK", "Config file must not be a symbolic link.");
  if (!info.isFile()) throw new ConfigError("CONFIG_NOT_REGULAR_FILE", "Config path must be a regular file.");
  let source: string;
  let parsed: unknown;
  try {
    source = await readFile(configPath, "utf8");
    if (hasDuplicateJsonObjectKey(source)) throw new Error("Duplicate JSON object key.");
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigError("CONFIG_INVALID", `Config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = validateConfig(parsed);
  if (!report.ok || !report.config) throw new ConfigError("CONFIG_INVALID", report.issues.map((issue) => issue.message).join(" "));
  return report.config;
}

export const loadConfig = loadTrustedConfig;
