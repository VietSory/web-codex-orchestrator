import { readFile } from "node:fs/promises";
import type { TrustedConfig, AgentConfig, VerificationConfig } from "../config/contracts.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { ExecutionError } from "./errors.js";
import type { AcceptanceContract, BundleManifest, RiskPolicy, TestMatrix, ValidationContract } from "../bundle/contracts.js";

export interface Phase4Config extends TrustedConfig { runtime: NonNullable<TrustedConfig["runtime"]>; agents: AgentConfig; verification: VerificationConfig; }

export async function loadPhase4Config(configPath: string): Promise<Phase4Config> {
  let config;
  try { config = await loadTrustedConfig(configPath); } catch (error) { throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Trusted Phase 4 config is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (!config.runtime || !config.agents || !config.verification) throw new ExecutionError("EXECUTION_CONFIG_INVALID", "Trusted config must include bundled runtime, agents, and verification for Phase 4.");
  return config as Phase4Config;
}

export const loadExecutionConfig = loadPhase4Config;

/** These files are read only after secure bundle intake/validation has accepted
 * the bundle. Preserve the validated contract types instead of discarding them
 * as unknown at every downstream authority check. */
export async function readBundleJson(bundlePath: string): Promise<{ manifest: BundleManifest; validation: ValidationContract; acceptance: AcceptanceContract; testMatrix: TestMatrix; riskPolicy: RiskPolicy; plan: string; request: string; rules: string }> {
  try {
    const manifest = JSON.parse(await readFile(`${bundlePath}/manifest.json`, "utf8")) as BundleManifest;
    const validation = JSON.parse(await readFile(`${bundlePath}/validation.json`, "utf8")) as ValidationContract;
    const acceptance = JSON.parse(await readFile(`${bundlePath}/acceptance.json`, "utf8")) as AcceptanceContract;
    const testMatrix = JSON.parse(await readFile(`${bundlePath}/test-matrix.json`, "utf8")) as TestMatrix;
    const riskPolicy = JSON.parse(await readFile(`${bundlePath}/risk-policy.json`, "utf8")) as RiskPolicy;
    const readText = async (name: string): Promise<string> => { try { return await readFile(`${bundlePath}/${name}`, "utf8"); } catch { return ""; } };
    return { manifest, validation, acceptance, testMatrix, riskPolicy, plan: await readText("PLAN.md"), request: await readText("REQUEST.md"), rules: await readText("RULES.md") };
  } catch (error) { throw new ExecutionError("EXECUTION_CONFIG_INVALID", `Accepted bundle metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
}

export function effectiveLimit(local: number, bundle: number): number { return Math.min(local, bundle); }
