import fs from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import {
  assertCompatibleCodexCliVersion,
  codexCliArgs,
  minimalCodexEnvironment,
  resolveCodexRuntime,
} from "../runtime/codex-runtime.js";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import { pauseRun, resumeRun } from "./controller.js";
import { readRunLedger } from "./ledger.js";
import { runDoctor, type DoctorProbe, type DoctorReport } from "./doctor.js";
import { deriveNextTransition, type PlannedTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition, type ContinueResult } from "./transition-runner.js";
import { OrchestrationError, type RunLedger } from "./contracts.js";

export interface ControlCliIo { stdout(value: string): void; stderr(value: string): void; }

export interface ControlArgs {
  runId?: string;
  stateDirectory: string;
  configPath?: string;
  json: boolean;
  webPackPath?: string;
  webVerdictPath?: string;
  maxTransitions: number;
}

export function parseControlArgs(command: string, argv: string[]): ControlArgs {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) {
      throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unexpected/duplicate option '${key}'.`);
    }
    if (key === "--json") { values.set(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Option '${key}' requires a value.`);
    }
    values.set(key, value);
    index += 1;
  }

  for (const key of values.keys()) {
    if (!["--run-id", "--state-dir", "--config", "--web-pack", "--web-verdict", "--max-transitions", "--json"].includes(key)) {
      throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown option '${key}'.`);
    }
  }

  const required = (key: string): string => {
    const value = values.get(key);
    if (typeof value !== "string" || !value) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Missing '${key}'.`);
    return value;
  };

  const maxRaw = typeof values.get("--max-transitions") === "string" ? Number(values.get("--max-transitions")) : 8;
  if (!Number.isSafeInteger(maxRaw) || maxRaw < 1 || maxRaw > 32) {
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--max-transitions must be 1..32.");
  }
  if (command !== "continue" && (values.has("--web-pack") || values.has("--web-verdict") || values.has("--max-transitions"))) {
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--web-pack/--web-verdict/--max-transitions are valid only for continue.");
  }

  const configValue = values.get("--config");
  if (["continue", "doctor"].includes(command) && typeof configValue !== "string") {
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--config'.");
  }
  const runIdValue = values.get("--run-id");
  if (command !== "doctor" && (typeof runIdValue !== "string" || !runIdValue)) {
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--run-id'.");
  }

  const webPack = values.get("--web-pack");
  const webVerdict = values.get("--web-verdict");
  return {
    ...(typeof runIdValue === "string" ? { runId: runIdValue } : {}),
    stateDirectory: path.resolve(required("--state-dir")),
    ...(typeof configValue === "string" ? { configPath: path.resolve(configValue) } : {}),
    json: values.get("--json") === true,
    ...(typeof webPack === "string" ? { webPackPath: path.resolve(webPack) } : {}),
    ...(typeof webVerdict === "string" ? { webVerdictPath: path.resolve(webVerdict) } : {}),
    maxTransitions: maxRaw,
  };
}

function requireRunId(args: ControlArgs): string {
  if (!args.runId) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--run-id'.");
  return args.runId;
}

function humanPlan(plan: PlannedTransition): string {
  return [`Next: ${plan.transition}`, `Reason: ${plan.reason}`, `Human action: ${plan.requires_human ? "required" : "no"}`].join("\n");
}

function humanLedger(ledger: RunLedger): string {
  const lines = [
    `Run: ${ledger.run_id}`,
    `Status: ${ledger.status}`,
    `Paused: ${ledger.paused ? "yes" : "no"}`,
    `Next: ${ledger.next_transition}`,
  ];
  if (ledger.current_attempt) lines.push(`Attempt: ${ledger.current_attempt.transition} #${ledger.current_attempt.attempt_number} (${ledger.current_attempt.status})`);
  if (ledger.retry.next_retry_at) lines.push(`Retry after: ${ledger.retry.next_retry_at}`);
  return lines.join("\n");
}

function humanStatus(value: { ledger: RunLedger | null; next: PlannedTransition }): string {
  if (!value.ledger) return [`Status: NOT_STARTED`, humanPlan(value.next)].join("\n");
  return [humanLedger(value.ledger), `Reason: ${value.next.reason}`].join("\n");
}

function humanContinue(result: ContinueResult): string {
  const lines = [
    humanLedger(result.ledger),
    `Progressed: ${result.progressed ? "yes" : "no"}`,
    `Reason: ${result.planned.reason}`,
  ];
  if (result.needs_input) lines.push(`Needs input: ${result.needs_input}`);
  return lines.join("\n");
}

function humanDoctor(report: DoctorReport): string {
  const checks = report.checks.map((check) => `[${check.severity}] ${check.id}: ${check.summary} (${check.duration_ms}ms)`);
  return [`Doctor: ${report.status}`, ...checks].join("\n");
}

function emit(io: ControlCliIo, json: boolean, humanValue: string, value: unknown): void {
  io.stdout(json ? JSON.stringify(value) : humanValue);
}

function fail(io: ControlCliIo, error: unknown, json: boolean): number {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "ORCHESTRATION_OPERATIONAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(json ? JSON.stringify({ error: code, message }) : `${code}: ${message}`);
  return 2;
}

function productionDoctorProbes(args: ControlArgs): DoctorProbe[] {
  const configPromise = loadTrustedConfig(args.configPath!);
  const runtimePromise = configPromise.then((config) => resolveCodexRuntime(config.runtime, args.stateDirectory));

  return [
    {
      id: "node",
      async run() {
        return {
          severity: Number(process.versions.node.split(".")[0]) >= 20 ? "OK" as const : "FAIL" as const,
          summary: `Node ${process.versions.node}`,
        };
      },
    },
    {
      id: "state",
      async run() {
        await fs.mkdir(args.stateDirectory, { recursive: true, mode: 0o700 });
        await fs.access(args.stateDirectory, fs.constants.R_OK | fs.constants.W_OK);
        return { severity: "OK" as const, summary: "state directory readable/writable" };
      },
    },
    {
      id: "config",
      async run() {
        const config = await configPromise;
        return {
          severity: "OK" as const,
          summary: `trusted config valid (${Object.keys(config.repositories).length} registered repos)`,
        };
      },
    },
    {
      id: "credentials",
      async run() {
        const config = await configPromise;
        const requiredKeys: string[] = [];
        if (config.publish?.authentication.mode === "https_token") requiredKeys.push(config.publish.authentication.token_environment_key);
        if (config.github_pull_request?.authentication.mode === "https_token") requiredKeys.push(config.github_pull_request.authentication.token_environment_key);
        const missing = [...new Set(requiredKeys)].filter((key) => !process.env[key]);
        return missing.length === 0
          ? { severity: "OK" as const, summary: requiredKeys.length === 0 ? "no Git/GitHub token env required by config" : "configured Git/GitHub credential env keys are present" }
          : { severity: "WARN" as const, summary: `missing credential env keys: ${missing.join(", ")}`, details: { missing_keys: missing } };
      },
    },
    {
      id: "git",
      async run() {
        const result = await spawnBounded({
          executable: "git",
          args: ["--version"],
          environment: { PATH: process.env.PATH ?? "" },
          timeoutMs: 2_000,
          stdoutMaxBytes: 4096,
          stderrMaxBytes: 4096,
          shell: false,
        });
        if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
          return { severity: "FAIL" as const, summary: result.stderr.trim() || result.spawnError || "git unavailable" };
        }
        return { severity: "OK" as const, summary: result.stdout.trim() };
      },
    },
    {
      id: "codex-runtime",
      async run() {
        const runtime = await runtimePromise;
        const result = await spawnBounded({
          executable: runtime.executable,
          args: codexCliArgs(runtime, ["--version"]),
          cwd: path.dirname(runtime.launcher_path),
          environment: minimalCodexEnvironment(runtime),
          timeoutMs: 4_000,
          stdoutMaxBytes: 16_384,
          stderrMaxBytes: 16_384,
          shell: false,
        });
        if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
          return { severity: "FAIL" as const, summary: result.stderr.trim() || result.spawnError || "pinned Codex runtime unavailable" };
        }
        const version = assertCompatibleCodexCliVersion(`${result.stdout}\n${result.stderr}`);
        return { severity: "OK" as const, summary: `pinned Codex ${version}` };
      },
    },
    {
      id: "codex-auth",
      async run() {
        const runtime = await runtimePromise;
        const result = await spawnBounded({
          executable: runtime.executable,
          args: codexCliArgs(runtime, ["login", "status"]),
          cwd: path.dirname(runtime.launcher_path),
          environment: minimalCodexEnvironment(runtime),
          timeoutMs: 4_000,
          stdoutMaxBytes: 16_384,
          stderrMaxBytes: 16_384,
          shell: false,
        });
        if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
          return { severity: "FAIL" as const, summary: "Codex authentication unavailable; authenticate the pinned CLI before model execution" };
        }
        return { severity: "OK" as const, summary: "Codex authentication available" };
      },
    },
  ];
}

export async function runControlCommand(command: string, argv: string[], io: ControlCliIo): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    const args = parseControlArgs(command, argv);
    if (command === "status") {
      const runId = requireRunId(args);
      const [ledger, snapshot] = await Promise.all([readRunLedger(args.stateDirectory, runId), readLifecycleSnapshot(args.stateDirectory, runId)]);
      const value = { ledger, snapshot, next: deriveNextTransition(snapshot) };
      emit(io, args.json, humanStatus(value), value);
      return 0;
    }
    if (command === "next") {
      const snapshot = await readLifecycleSnapshot(args.stateDirectory, requireRunId(args));
      const plan = deriveNextTransition(snapshot);
      emit(io, args.json, humanPlan(plan), plan);
      return 0;
    }
    if (command === "pause") {
      const ledger = await pauseRun(args.stateDirectory, requireRunId(args), "operator pause");
      emit(io, args.json, humanLedger(ledger), ledger);
      return 0;
    }
    if (command === "resume") {
      const ledger = await resumeRun(args.stateDirectory, requireRunId(args));
      emit(io, args.json, humanLedger(ledger), ledger);
      return 0;
    }
    if (command === "doctor") {
      const report = await runDoctor(productionDoctorProbes(args), { probe_timeout_ms: 6_000 });
      emit(io, args.json, humanDoctor(report), report);
      return report.status === "FAIL" ? 2 : 0;
    }
    if (command === "continue") {
      const runId = requireRunId(args);
      let latest: Awaited<ReturnType<typeof runNextTransition>> | null = null;
      for (let index = 0; index < args.maxTransitions; index += 1) {
        const inputs = {
          ...(args.webPackPath ? { web_pack_path: args.webPackPath } : {}),
          ...(args.webVerdictPath ? { web_verdict_path: args.webVerdictPath } : {}),
        };
        latest = await runNextTransition({
          runId,
          stateDirectory: args.stateDirectory,
          configPath: args.configPath!,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        });
        if (!latest.progressed || latest.needs_input || ["WAIT_HUMAN", "DONE"].includes(latest.planned.transition)) break;
      }
      const value = latest ?? { progressed: false, message: "no transition executed" };
      emit(io, args.json, latest ? humanContinue(latest) : "No transition executed.", value);
      return 0;
    }
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown control command '${command}'.`);
  } catch (error) {
    return fail(io, error, wantsJson);
  }
}
