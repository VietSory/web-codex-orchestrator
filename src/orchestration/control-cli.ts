import fs from "node:fs/promises";
import path from "node:path";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import { pauseRun, resumeRun, ensureRunLedger } from "./controller.js";
import { runDoctor, type DoctorProbe } from "./doctor.js";
import { deriveNextTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition } from "./transition-runner.js";
import { OrchestrationError } from "./contracts.js";

export interface ControlCliIo { stdout(value: string): void; stderr(value: string): void; }

interface CommonArgs { runId: string; stateDirectory: string; configPath: string; json: boolean; webPackPath?: string; maxTransitions: number; }

function parse(argv: string[]): CommonArgs {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unexpected/duplicate option '${key}'.`);
    if (key === "--json") { values.set(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Option '${key}' requires a value.`);
    values.set(key, value); index += 1;
  }
  for (const key of values.keys()) if (!["--run-id","--state-dir","--config","--web-pack","--max-transitions","--json"].includes(key)) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown option '${key}'.`);
  const required = (key: string): string => { const value = values.get(key); if (typeof value !== "string" || !value) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Missing '${key}'.`); return value; };
  const maxRaw = typeof values.get("--max-transitions") === "string" ? Number(values.get("--max-transitions")) : 8;
  if (!Number.isSafeInteger(maxRaw) || maxRaw < 1 || maxRaw > 32) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--max-transitions must be 1..32.");
  const webPack = values.get("--web-pack");
  return {
    runId: required("--run-id"),
    stateDirectory: path.resolve(required("--state-dir")),
    configPath: path.resolve(required("--config")),
    json: values.get("--json") === true,
    ...(typeof webPack === "string" ? { webPackPath: path.resolve(webPack) } : {}),
    maxTransitions: maxRaw,
  };
}

function emit(io: ControlCliIo, json: boolean, value: unknown): void {
  io.stdout(json ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
function fail(io: ControlCliIo, error: unknown): number {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ORCHESTRATION_OPERATIONAL_ERROR";
  io.stderr(JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) }));
  return 2;
}

function basicDoctorProbes(args: CommonArgs): DoctorProbe[] {
  return [
    { id: "node", async run() { return { severity: Number(process.versions.node.split(".")[0]) >= 20 ? "OK" as const : "FAIL" as const, summary: `Node ${process.versions.node}` }; } },
    { id: "state", async run() { await fs.mkdir(args.stateDirectory, { recursive: true, mode: 0o700 }); await fs.access(args.stateDirectory, fs.constants.R_OK | fs.constants.W_OK); return { severity: "OK" as const, summary: "state directory readable/writable" }; } },
    { id: "config", async run() { const stat = await fs.stat(args.configPath); return { severity: stat.isFile() ? "OK" as const : "FAIL" as const, summary: stat.isFile() ? "config file present" : "config path is not a file" }; } },
    { id: "git", async run() { const result = await spawnBounded({ executable: "git", args: ["--version"], environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 2_000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096, shell: false }); if (result.exitCode !== 0 || result.timedOut || result.spawnError) return { severity: "FAIL" as const, summary: result.stderr.trim() || "git unavailable" }; return { severity: "OK" as const, summary: result.stdout.trim() }; } },
  ];
}

export async function runControlCommand(command: string, argv: string[], io: ControlCliIo): Promise<number> {
  try {
    const args = parse(argv);
    if (command === "status") {
      const [ledger, snapshot] = await Promise.all([ensureRunLedger(args.stateDirectory, args.runId), readLifecycleSnapshot(args.stateDirectory, args.runId)]);
      emit(io, args.json, { ledger, snapshot, next: deriveNextTransition(snapshot) }); return 0;
    }
    if (command === "next") {
      const snapshot = await readLifecycleSnapshot(args.stateDirectory, args.runId);
      emit(io, args.json, deriveNextTransition(snapshot)); return 0;
    }
    if (command === "pause") {
      emit(io, args.json, await pauseRun(args.stateDirectory, args.runId, "operator pause")); return 0;
    }
    if (command === "resume") {
      emit(io, args.json, await resumeRun(args.stateDirectory, args.runId)); return 0;
    }
    if (command === "doctor") {
      const report = await runDoctor(basicDoctorProbes(args)); emit(io, args.json, report); return report.status === "FAIL" ? 2 : 0;
    }
    if (command === "continue") {
      let latest: Awaited<ReturnType<typeof runNextTransition>> | null = null;
      for (let index = 0; index < args.maxTransitions; index += 1) {
        latest = await runNextTransition({ runId: args.runId, stateDirectory: args.stateDirectory, configPath: args.configPath, ...(args.webPackPath ? { inputs: { web_pack_path: args.webPackPath } } : {}) });
        if (!latest.progressed || latest.needs_input || ["WAIT_WEB_VERDICT","WAIT_HUMAN","OPEN_DRAFT_PR","PACKAGE_RESULT","REVISE","DONE"].includes(latest.planned.transition)) break;
      }
      emit(io, args.json, latest ?? { progressed: false, message: "no transition executed" }); return 0;
    }
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown control command '${command}'.`);
  } catch (error) { return fail(io, error); }
}
