import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { TrustedConfig, AgentConfig, VerificationConfig } from "../config/contracts.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { ExecutionError } from "./errors.js";
import type { BundleManifest } from "../bundle/contracts.js";

const MAX_BUNDLE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_METADATA_BYTES = 64 * 1024 * 1024;

export interface Phase4Config extends TrustedConfig { runtime: NonNullable<TrustedConfig["runtime"]>; agents: AgentConfig; verification: VerificationConfig; }

export async function loadPhase4Config(configPath: string): Promise<Phase4Config> {
  let config;
  try { config = await loadTrustedConfig(configPath); } catch (error) { throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Trusted Phase 4 config is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (!config.runtime || !config.agents || !config.verification) throw new ExecutionError("EXECUTION_CONFIG_INVALID", "Trusted config must include bundled runtime, agents, and verification for Phase 4.");
  return config as Phase4Config;
}

export const loadExecutionConfig = loadPhase4Config;

async function readStableBundleFile(filePath: string): Promise<Buffer | undefined> {
  let pathBefore: Stats;
  try { pathBefore = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_BUNDLE_FILE_BYTES) {
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle file is unsafe or exceeds ${MAX_BUNDLE_FILE_BYTES} bytes: ${filePath}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Cannot safely open accepted bundle file: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_BUNDLE_FILE_BYTES) {
      throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle file changed before open: ${filePath}`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle file was truncated while reading: ${filePath}`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle file grew while reading: ${filePath}`);
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle file changed while reading: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readBundleJson(bundlePath: string): Promise<{ manifest: BundleManifest; validation: unknown; acceptance: unknown; testMatrix: unknown; riskPolicy: unknown; plan: string; request: string; rules: string }> {
  let totalBytes = 0;
  const readRequired = async (name: string): Promise<Buffer> => {
    const bytes = await readStableBundleFile(path.join(bundlePath, name));
    if (!bytes) throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle metadata is missing: ${name}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_METADATA_BYTES) throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle metadata exceeds ${MAX_BUNDLE_METADATA_BYTES} aggregate bytes.`);
    return bytes;
  };
  const readOptionalText = async (name: string): Promise<string> => {
    const bytes = await readStableBundleFile(path.join(bundlePath, name));
    if (!bytes) return "";
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_METADATA_BYTES) throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle metadata exceeds ${MAX_BUNDLE_METADATA_BYTES} aggregate bytes.`);
    return bytes.toString("utf8");
  };
  try {
    const manifest = JSON.parse((await readRequired("manifest.json")).toString("utf8")) as BundleManifest;
    const validation = JSON.parse((await readRequired("validation.json")).toString("utf8")) as unknown;
    const acceptance = JSON.parse((await readRequired("acceptance.json")).toString("utf8")) as unknown;
    const testMatrix = JSON.parse((await readRequired("test-matrix.json")).toString("utf8")) as unknown;
    const riskPolicy = JSON.parse((await readRequired("risk-policy.json")).toString("utf8")) as unknown;
    return {
      manifest,
      validation,
      acceptance,
      testMatrix,
      riskPolicy,
      plan: await readOptionalText("PLAN.md"),
      request: await readOptionalText("REQUEST.md"),
      rules: await readOptionalText("RULES.md"),
    };
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function effectiveLimit(local: number, bundle: number): number { return Math.min(local, bundle); }
