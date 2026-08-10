#!/usr/bin/env node
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { createConfiguredWebBridge } from "../web-bridge/bridge-factory.js";
import { driveAutopilotJob } from "./autopilot-job.js";

interface Args {
  runId: string;
  stateDirectory: string;
  configPath: string;
  maxCycles?: number;
  json: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  node dist/orchestration/autopilot-standalone-cli.js --run-id <prepared-task-id:sha256> [--state-dir <directory>] [--config <config.json>] [--max-cycles <1-128>] [--json]",
    "",
    "AUTOPILOT starts from an already prepared Task Bundle run and reuses WCO's repair-capable execution, publish, Draft PR, Result Bundle, Web review, and revision services.",
    "PAIR remains the default `wco` interactive workflow.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) throw new Error(`AUTOPILOT_CLI_INVALID: unexpected or duplicate option '${key}'.`);
    if (key === "--json") { values.set(key, true); continue; }
    if (!["--run-id", "--state-dir", "--config", "--max-cycles"].includes(key)) throw new Error(`AUTOPILOT_CLI_INVALID: unknown option '${key}'.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`AUTOPILOT_CLI_INVALID: option '${key}' requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const paths = resolveWcoPaths({
    ...(typeof values.get("--state-dir") === "string" ? { stateDirectory: path.resolve(values.get("--state-dir") as string) } : {}),
    ...(typeof values.get("--config") === "string" ? { configPath: path.resolve(values.get("--config") as string) } : {}),
  });
  const runId = values.get("--run-id");
  if (typeof runId !== "string" || !runId) throw new Error("AUTOPILOT_CLI_INVALID: missing '--run-id'.");
  const maxCyclesRaw = values.get("--max-cycles");
  let maxCycles: number | undefined;
  if (typeof maxCyclesRaw === "string") {
    maxCycles = Number(maxCyclesRaw);
    if (!Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > 128) throw new Error("AUTOPILOT_CLI_INVALID: --max-cycles must be 1..128.");
  }
  return { runId, stateDirectory: paths.state, configPath: paths.config, ...(maxCycles !== undefined ? { maxCycles } : {}), json: values.get("--json") === true };
}

function human(receipt: Awaited<ReturnType<typeof driveAutopilotJob>>): string {
  return [
    `AUTOPILOT ${receipt.status}`,
    `Run: ${receipt.run_id}`,
    `Stage: ${receipt.stage}`,
    `Web review rounds: ${receipt.web_review_rounds}`,
    `Revision rounds: ${receipt.revision_rounds_completed}`,
    `Action: ${receipt.terminal_action ?? "none"}`,
    ...(receipt.reason ? [`Reason: ${receipt.reason}`] : []),
  ].join("\n");
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { process.stdout.write(`${usage()}\n`); return 0; }
  let parsed: Args;
  try { parsed = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`); return 2; }

  try {
    const config = await loadTrustedConfig(parsed.configPath);
    const paths = resolveWcoPaths({ configPath: parsed.configPath, stateDirectory: parsed.stateDirectory });
    const bridge = createConfiguredWebBridge(config, paths.bridge);
    const receipt = await driveAutopilotJob({
      bridge,
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      ...(parsed.maxCycles !== undefined ? { maxCycles: parsed.maxCycles } : {}),
    });
    process.stdout.write(parsed.json ? `${JSON.stringify(receipt)}\n` : `${human(receipt)}\n`);
    return receipt.status === "READY_FOR_YOU" ? 0 : receipt.status === "NEEDS_YOU" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(parsed.json ? `${JSON.stringify({ status: "failed", message })}\n` : `${message}\n`);
    return 3;
  }
}

process.exitCode = await main();
