import fs from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import {
  assertCompatibleCodexCliVersion,
  codexCliArgs,
  minimalCodexEnvironment,
  resolveCodexRuntime,
} from "../runtime/codex-runtime.js";
import { spawnBounded, type SpawnBoundedResult } from "../runtime/spawn-bounded.js";
import { BubblewrapVerificationSandbox } from "../verifier/bubblewrap-sandbox.js";
import { pauseRun, resumeRun } from "./controller.js";
import { readRunLedger } from "./ledger.js";
import { runDoctor, type DoctorProbe, type DoctorReport } from "./doctor.js";
import type { JobMode } from "./job-mode.js";
import { deriveNextTransition, type LifecycleSnapshot, type PlannedTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition, type ContinueResult } from "./transition-runner.js";
import { OrchestrationError, type RunLedger } from "./contracts.js";
import { resolveGitHubToken } from "../setup/credential-provider.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { resolveManagedWebService } from "../web-bridge/managed-service.js";
import { ManagedWebOnboardingClient } from "../web-bridge/managed-onboarding.js";
import { createConfiguredWebBridge } from "../web-bridge/bridge-factory.js";
import { readRelayToken } from "../web-bridge/relay-credential.js";
import { readNativeOpenAiCredential } from "../web-bridge/native-openai-credential.js";

export interface ControlCliIo { stdout(value: string): void; stderr(value: string): void; }

export interface ControlArgs {
  runId?: string;
  stateDirectory: string;
  configPath?: string;
  json: boolean;
  webPackPath?: string;
  webVerdictPath?: string;
  doctorMode: JobMode;
  maxTransitions: number;
}

export function parseControlArgs(command: string, argv: string[]): ControlArgs {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unexpected/duplicate option '${key}'.`);
    if (key === "--json") { values.set(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Option '${key}' requires a value.`);
    values.set(key, value);
    index += 1;
  }

  for (const key of values.keys()) {
    if (!["--run-id", "--state-dir", "--config", "--web-pack", "--web-verdict", "--max-transitions", "--mode", "--json"].includes(key)) {
      throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown option '${key}'.`);
    }
  }

  const required = (key: string): string => {
    const value = values.get(key);
    if (typeof value !== "string" || !value) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Missing '${key}'.`);
    return value;
  };
  const maxRaw = typeof values.get("--max-transitions") === "string" ? Number(values.get("--max-transitions")) : 8;
  if (!Number.isSafeInteger(maxRaw) || maxRaw < 1 || maxRaw > 32) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--max-transitions must be 1..32.");
  if (command !== "continue" && (values.has("--web-pack") || values.has("--web-verdict") || values.has("--max-transitions"))) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--web-pack/--web-verdict/--max-transitions are valid only for continue.");
  if (command !== "doctor" && values.has("--mode")) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--mode is valid only for doctor.");

  const configValue = values.get("--config");
  if (["continue", "doctor"].includes(command) && typeof configValue !== "string") throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--config'.");
  const runIdValue = values.get("--run-id");
  if (command !== "doctor" && (typeof runIdValue !== "string" || !runIdValue)) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--run-id'.");
  const modeRaw = values.get("--mode");
  if (typeof modeRaw === "string" && modeRaw !== "PAIR" && modeRaw !== "AUTOPILOT") throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "--mode must be PAIR or AUTOPILOT.");

  const webPack = values.get("--web-pack");
  const webVerdict = values.get("--web-verdict");
  return {
    ...(typeof runIdValue === "string" ? { runId: runIdValue } : {}),
    stateDirectory: path.resolve(required("--state-dir")),
    ...(typeof configValue === "string" ? { configPath: path.resolve(configValue) } : {}),
    json: values.get("--json") === true,
    ...(typeof webPack === "string" ? { webPackPath: path.resolve(webPack) } : {}),
    ...(typeof webVerdict === "string" ? { webVerdictPath: path.resolve(webVerdict) } : {}),
    doctorMode: typeof modeRaw === "string" ? modeRaw : "PAIR",
    maxTransitions: maxRaw,
  };
}

function requireRunId(args: ControlArgs): string {
  if (!args.runId) throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", "Missing '--run-id'.");
  return args.runId;
}

function humanPlan(plan: PlannedTransition): string { return [`Next: ${plan.transition}`, `Reason: ${plan.reason}`, `Human action: ${plan.requires_human ? "required" : "no"}`].join("\n"); }
function humanLedger(ledger: RunLedger): string {
  const lines = [`Run: ${ledger.run_id}`, `Status: ${ledger.status}`, `Paused: ${ledger.paused ? "yes" : "no"}`, `Next: ${ledger.next_transition}`];
  if (ledger.current_attempt) lines.push(`Attempt: ${ledger.current_attempt.transition} #${ledger.current_attempt.attempt_number} (${ledger.current_attempt.status})`);
  if (ledger.retry.next_retry_at) lines.push(`Retry after: ${ledger.retry.next_retry_at}`);
  return lines.join("\n");
}
function progressMarker(complete: boolean, active: boolean): string { return complete ? "✓" : active ? "●" : "○"; }
function stageLine(label: string, complete: boolean, active: boolean): string { return `  ${progressMarker(complete, active)} ${label}`; }
function humanProgress(snapshot: LifecycleSnapshot, next: PlannedTransition): string[] {
  const executorComplete = snapshot.executor_state === "READY_FOR_PUBLISH";
  const reviewComplete = snapshot.web_review_state === "APPROVED" || snapshot.web_review_state === "ESCALATED";
  return [
    "Progress", "  ✓ Run prepared",
    stageLine("Web implementation registered", snapshot.registered_artifact_sha256 !== null, next.transition === "REGISTER_WEB_PACK"),
    stageLine("Implementation and deterministic verification", executorComplete, next.transition === "EXECUTE_REGISTERED_PACK"),
    stageLine("Approved change published", snapshot.publish_state === "PUSHED", next.transition === "PUBLISH"),
    stageLine("Draft PR open", snapshot.draft_pr_state === "OPEN", next.transition === "OPEN_DRAFT_PR"),
    stageLine("Review bundle ready", snapshot.result_bundle_ready, next.transition === "PACKAGE_RESULT"),
    stageLine("External review decision", reviewComplete, next.transition === "WAIT_WEB_VERDICT" || next.transition === "REVISE"),
  ];
}
function humanBudget(ledger: RunLedger): string[] {
  return ["Resources", `  Attempts: ${ledger.budget.total_attempts}/${ledger.budget.max_total_attempts}`, `  Model turns: ${ledger.budget.model_turns}/${ledger.budget.max_model_turns}`, `  Input tokens: ${ledger.budget.input_tokens}/${ledger.budget.max_input_tokens}`, `  Output tokens: ${ledger.budget.output_tokens}/${ledger.budget.max_output_tokens}`];
}
type StatusValue = { ledger: RunLedger | null; snapshot: LifecycleSnapshot; next: PlannedTransition };
function humanStatus(value: StatusValue): string {
  if (!value.ledger) return ["Status: NOT_STARTED", humanPlan(value.next)].join("\n");
  const lines = [`Run: ${value.ledger.run_id}`, `Status: ${value.ledger.status}${value.ledger.paused ? " (PAUSED)" : ""}`, "", ...humanProgress(value.snapshot, value.next), "", ...humanBudget(value.ledger), "", `Next: ${value.next.transition}`, `Reason: ${value.next.reason}`];
  if (value.ledger.current_attempt) lines.push(`Current attempt: ${value.ledger.current_attempt.transition} #${value.ledger.current_attempt.attempt_number} (${value.ledger.current_attempt.status})`);
  if (value.ledger.retry.next_retry_at) lines.push(`Retry after: ${value.ledger.retry.next_retry_at}`);
  return lines.join("\n");
}
function inputHint(input: string | null): string | null {
  if (input === "web_pack_path") return "Input required: provide --web-pack <zip> to continue.";
  if (input === "web_verdict_path") return "Input required: provide --web-verdict <json> to continue.";
  if (input === "resume") return "Run is paused. Use `wco resume` before continuing.";
  return input ? `Input required: ${input}` : null;
}
function humanContinue(result: ContinueResult): string {
  const lines = [humanLedger(result.ledger), `Progressed: ${result.progressed ? "yes" : "no"}`, `Reason: ${result.planned.reason}`];
  const hint = inputHint(result.needs_input); if (hint) lines.push(hint); return lines.join("\n");
}
function humanDoctor(report: DoctorReport, mode: JobMode): string {
  const marker = (severity: string): string => severity === "OK" ? "✓" : severity === "WARN" ? "!" : "✗";
  const checks = report.checks.map((check) => `${marker(check.severity)} ${check.id}: ${check.summary} (${check.duration_ms}ms)`);
  return [`WCO Doctor · ${mode}`, "", ...checks, "", `Ready to run: ${report.status === "FAIL" ? "NO" : "YES"}`].join("\n");
}
function emit(io: ControlCliIo, json: boolean, humanValue: string, value: unknown): void { io.stdout(json ? JSON.stringify(value) : humanValue); }
function fail(io: ControlCliIo, error: unknown, json: boolean): number {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ORCHESTRATION_OPERATIONAL_ERROR";
  const message = error instanceof Error ? error.message : String(error); io.stderr(json ? JSON.stringify({ error: code, message }) : `${code}: ${message}`); return 2;
}
function processFailureSummary(result: SpawnBoundedResult, fallback: string): string {
  const stderr = result.stderr.trim(); if (stderr) return stderr; if (result.spawnError instanceof Error) return result.spawnError.message; if (result.spawnError !== undefined) return String(result.spawnError); if (result.timedOut) return `${fallback} (timed out)`; return fallback;
}
function lazyPromise<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => promise ??= factory();
}

export function productionDoctorProbes(args: ControlArgs): DoctorProbe[] {
  const loadConfig = lazyPromise(() => loadTrustedConfig(args.configPath!));
  const webPaths = resolveWcoPaths({ configPath: args.configPath!, stateDirectory: args.stateDirectory });
  const webFailure = (label: string, error: unknown) => ({ severity: "WARN" as const, summary: `${label} FAIL - ${error instanceof Error ? error.message : String(error)}` });
  const webMode = lazyPromise(() => loadConfig().then((config) => config.web_bridge?.mode ?? "chatgpt_codex"));
  const loadRuntime = lazyPromise(() => loadConfig().then((config) => resolveCodexRuntime(config.runtime, args.stateDirectory)));
  const codexRequired = async (): Promise<boolean> => (await webMode()) === "chatgpt_codex" || args.doctorMode === "AUTOPILOT";
  const loadManagedService = lazyPromise(() => loadConfig().then(async (config) => {
    if (config.web_bridge?.mode !== "managed_actions") throw new Error("managed Web mode is not configured");
    const metadata = resolveManagedWebService();
    const client = new ManagedWebOnboardingClient({ metadata, credentialsDirectory: webPaths.credentials });
    const service = await client.probeServiceStatus();
    return { config, client, service };
  }));
  const loadManagedConnection = lazyPromise(() => loadManagedService().then(async ({ config, client, service }) => {
    await client.accessToken();
    const connection = await createConfiguredWebBridge(config, webPaths.bridge).getConnectionStatus();
    return { service, connection };
  }));
  const loadLocalConnection = lazyPromise(() => loadConfig().then(async (config) => {
    if ((config.web_bridge?.mode ?? "chatgpt_codex") !== "chatgpt_codex") throw new Error("local ChatGPT/Codex mode is not configured");
    return await createConfiguredWebBridge(config, webPaths.bridge).getConnectionStatus();
  }));
  const loadPersonalConnection = lazyPromise(() => loadConfig().then(async (config) => {
    if (config.web_bridge?.mode !== "personal_actions" && config.web_bridge?.mode !== "actions_relay") throw new Error("personal Web mode is not configured");
    await readRelayToken(webPaths.credentials);
    return await createConfiguredWebBridge(config, webPaths.bridge).getConnectionStatus();
  }));
  const loadNativeCredential = lazyPromise(() => loadConfig().then(async (config) => {
    if (config.web_bridge?.mode !== "web_native_mcp") throw new Error("OpenAI Web-native mode is not configured");
    return await readNativeOpenAiCredential(webPaths.credentials);
  }));

  const probes: DoctorProbe[] = [
    { id: "node", async run() { return { severity: Number(process.versions.node.split(".")[0]) >= 22 ? "OK" as const : "FAIL" as const, summary: `Node ${process.versions.node}` }; } },
    { id: "state", async run() { await fs.mkdir(args.stateDirectory, { recursive: true, mode: 0o700 }); await fs.access(args.stateDirectory, fs.constants.R_OK | fs.constants.W_OK); return { severity: "OK" as const, summary: "state directory readable/writable" }; } },
    { id: "config", async run() { const config = await loadConfig(); return { severity: "OK" as const, summary: `trusted config valid (${Object.keys(config.repositories).length} registered repos)` }; } },
    { id: "credentials", async run() {
      const config = await loadConfig();
      const requiredKeys: string[] = [];
      if (config.publish?.authentication.mode === "https_token") requiredKeys.push(config.publish.authentication.token_environment_key);
      if (config.github_pull_request?.authentication.mode === "https_token") requiredKeys.push(config.github_pull_request.authentication.token_environment_key);
      const missing = [...new Set(requiredKeys)].filter((key) => !process.env[key]);
      if (missing.length) return { severity: "WARN" as const, summary: `missing credential env keys: ${missing.join(", ")}`, details: { missing_keys: missing } };
      const ghAuthentication = config.github_pull_request?.authentication.mode === "gh_cli" ? config.github_pull_request.authentication : config.publish?.authentication.mode === "gh_cli" ? config.publish.authentication : undefined;
      if (ghAuthentication) { try { await resolveGitHubToken(ghAuthentication); } catch { return { severity: "FAIL" as const, summary: "GitHub CLI authentication is unavailable; run `gh auth login` and retry" }; } return { severity: "OK" as const, summary: "GitHub CLI authentication available" }; }
      return { severity: "OK" as const, summary: requiredKeys.length === 0 ? "no Git/GitHub token env required by config" : "configured Git/GitHub credential env keys are present" };
    } },
    { id: "git", async run() {
      const result = await spawnBounded({ executable: "git", args: ["--version"], environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 2_000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096, shell: false });
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) return { severity: "FAIL" as const, summary: processFailureSummary(result, "git unavailable") };
      return { severity: "OK" as const, summary: result.stdout.trim() };
    } },
    { id: "verification-sandbox", async run() { await new BubblewrapVerificationSandbox().checkAvailability(); return { severity: "OK" as const, summary: "Bubblewrap verification sandbox available with isolated filesystem/network namespaces" }; } },
    { id: "codex-runtime", async run() {
      if (!await codexRequired()) return { severity: "OK" as const, summary: "explicit advanced PAIR profile does not require the local Codex runtime" };
      const runtime = await loadRuntime();
      const result = await spawnBounded({ executable: runtime.executable, args: codexCliArgs(runtime, ["--version"]), cwd: path.dirname(runtime.launcher_path), environment: minimalCodexEnvironment(runtime), timeoutMs: 4_000, stdoutMaxBytes: 16_384, stderrMaxBytes: 16_384, shell: false });
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) return { severity: "FAIL" as const, summary: processFailureSummary(result, "pinned Codex runtime unavailable") };
      const version = assertCompatibleCodexCliVersion(`${result.stdout}\n${result.stderr}`);
      return { severity: "OK" as const, summary: `pinned Codex ${version}` };
    } },
    { id: "codex-auth", async run() {
      const mode = await webMode();
      if (mode !== "chatgpt_codex" && args.doctorMode !== "AUTOPILOT") return { severity: "OK" as const, summary: "explicit advanced PAIR profile does not require local Codex authentication" };
      const runtime = await loadRuntime();
      const result = await spawnBounded({ executable: runtime.executable, args: codexCliArgs(runtime, ["login", "status"]), cwd: path.dirname(runtime.launcher_path), environment: minimalCodexEnvironment(runtime), timeoutMs: 4_000, stdoutMaxBytes: 16_384, stderrMaxBytes: 16_384, shell: false });
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
        return { severity: "FAIL" as const, summary: mode === "chatgpt_codex" ? "ChatGPT authorization unavailable for the local Codex transport; run `wco web connect`" : "Codex authentication unavailable before AUTOPILOT model review" };
      }
      return { severity: "OK" as const, summary: mode === "chatgpt_codex" ? "ChatGPT authorization available through the pinned Codex runtime" : "Codex authentication available for AUTOPILOT review" };
    } },
    { id: "wco-relay-service", async run() {
      const mode = await webMode();
      if (mode === "chatgpt_codex") return { severity: "OK" as const, summary: "local ChatGPT/Codex transport; no relay or hosted service required" };
      if (mode === "manual_file") return { severity: "OK" as const, summary: "offline manual_file profile; no relay probe required" };
      if (mode === "web_native_mcp") { try { await loadNativeCredential(); return { severity: "OK" as const, summary: "official OpenAI Secure MCP Tunnel profile; no third-party relay required" }; } catch (error) { return { severity: "FAIL" as const, summary: `OpenAI Web-native setup incomplete - ${error instanceof Error ? error.message : String(error)}` }; } }
      if (mode === "personal_actions" || mode === "actions_relay") { try { const status = await loadPersonalConnection(); return status.connected ? { severity: "OK" as const, summary: "PASS - personal bearer relay reachable" } : { severity: "WARN" as const, summary: "personal relay offline" }; } catch (error) { return webFailure("Personal WCO Relay", error); } }
      try { await loadManagedService(); return { severity: "OK" as const, summary: "PASS - managed service reachable and compatible" }; } catch (error) { return webFailure("Managed WCO Relay service", error); }
    } },
    { id: "wco-device-account", async run() {
      const mode = await webMode();
      if (mode !== "managed_actions") return { severity: "OK" as const, summary: `${mode} profile has no managed device/account requirement` };
      try { const { client } = await loadManagedService(); await client.accessToken(); return { severity: "OK" as const, summary: "PASS - scoped device/account credential valid" }; } catch (error) { return webFailure("WCO device/account", error); }
    } },
    { id: "chatgpt-web", async run() {
      const mode = await webMode();
      if (mode === "chatgpt_codex") {
        try {
          const status = await loadLocalConnection();
          return status.configured && status.connected
            ? { severity: "OK" as const, summary: "local ChatGPT/Codex semantic transport reachable; authorization is checked separately" }
            : { severity: "FAIL" as const, summary: "local ChatGPT/Codex semantic transport unavailable" };
        } catch (error) {
          return { severity: "FAIL" as const, summary: `local ChatGPT/Codex semantic transport unavailable - ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (mode === "manual_file") return { severity: "OK" as const, summary: "offline manual_file profile" };
      if (mode === "web_native_mcp") { try { await loadNativeCredential(); return { severity: "OK" as const, summary: "official ChatGPT Web-native MCP credential configured" }; } catch (error) { return { severity: "FAIL" as const, summary: `Web-native authorization missing - ${error instanceof Error ? error.message : String(error)}` }; } }
      if (mode === "personal_actions" || mode === "actions_relay") { try { return (await loadPersonalConnection()).connected ? { severity: "OK" as const, summary: "personal Action relay linked" } : { severity: "WARN" as const, summary: "personal Action relay not linked" }; } catch { return { severity: "WARN" as const, summary: "personal Action relay not linked" }; } }
      try { const value = await loadManagedConnection(); return value.service.chatgpt_oauth_configured && value.connection.connected ? { severity: "OK" as const, summary: "managed OAuth linked" } : { severity: "WARN" as const, summary: "managed OAuth not linked" }; } catch { return { severity: "WARN" as const, summary: "managed OAuth not linked" }; }
    } },
    { id: "senior-architect-gpt", async run() {
      const config = await loadConfig(), mode = config.web_bridge?.mode ?? "chatgpt_codex";
      if (mode === "chatgpt_codex") return { severity: "OK" as const, summary: "local ChatGPT/Codex transport has no Custom GPT or Workspace Agent requirement" };
      if (mode === "manual_file") return { severity: "OK" as const, summary: "not required for offline manual_file profile" };
      if (mode === "web_native_mcp") { try { await loadNativeCredential(); return { severity: "OK" as const, summary: "private WCO Workspace Agent trigger configured" }; } catch { return { severity: "FAIL" as const, summary: "private WCO Workspace Agent trigger not configured; run `wco web connect`" }; } }
      if (mode === "personal_actions" || mode === "actions_relay") return config.web_bridge?.gpt_url ? { severity: "OK" as const, summary: "personal GPT metadata configured" } : { severity: "WARN" as const, summary: "personal GPT one-time editor setup not yet recorded" };
      try { const value = await loadManagedService(); return value.service.senior_architect_gpt_configured ? { severity: "OK" as const, summary: "managed GPT configured" } : { severity: "WARN" as const, summary: "managed GPT not configured" }; } catch { return { severity: "WARN" as const, summary: "managed GPT not configured" }; }
    } },
  ];

  return probes;
}

export async function runControlCommand(command: string, argv: string[], io: ControlCliIo): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    const args = parseControlArgs(command, argv);
    if (command === "status") {
      const runId = requireRunId(args);
      const [ledger, snapshot] = await Promise.all([readRunLedger(args.stateDirectory, runId), readLifecycleSnapshot(args.stateDirectory, runId)]);
      const value = { ledger, snapshot, next: deriveNextTransition(snapshot) };
      emit(io, args.json, humanStatus(value), value); return 0;
    }
    if (command === "next") { const snapshot = await readLifecycleSnapshot(args.stateDirectory, requireRunId(args)); const plan = deriveNextTransition(snapshot); emit(io, args.json, humanPlan(plan), plan); return 0; }
    if (command === "pause") { const ledger = await pauseRun(args.stateDirectory, requireRunId(args), "operator pause"); emit(io, args.json, humanLedger(ledger), ledger); return 0; }
    if (command === "resume") {
      const runId = requireRunId(args); const ledger = await resumeRun(args.stateDirectory, runId);
      if (args.json) { emit(io, true, "", ledger); return 0; }
      const snapshot = await readLifecycleSnapshot(args.stateDirectory, runId); const next = deriveNextTransition(snapshot);
      emit(io, false, [`Resumed: ${runId}`, "Recovery and exact-state re-attestation will run before the next side effect.", "", humanStatus({ ledger, snapshot, next })].join("\n"), ledger); return 0;
    }
    if (command === "doctor") {
      const report = await runDoctor(productionDoctorProbes(args), { probe_timeout_ms: 8_000 });
      const value = { mode: args.doctorMode, ...report };
      emit(io, args.json, humanDoctor(report, args.doctorMode), value); return report.status === "FAIL" ? 2 : 0;
    }
    if (command === "continue") {
      const runId = requireRunId(args); let latest: Awaited<ReturnType<typeof runNextTransition>> | null = null;
      for (let index = 0; index < args.maxTransitions; index += 1) {
        const inputs = { ...(args.webPackPath ? { web_pack_path: args.webPackPath } : {}), ...(args.webVerdictPath ? { web_verdict_path: args.webVerdictPath } : {}) };
        latest = await runNextTransition({ runId, stateDirectory: args.stateDirectory, configPath: args.configPath!, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) });
        if (!latest.progressed || latest.needs_input || ["WAIT_HUMAN", "DONE"].includes(latest.planned.transition)) break;
      }
      const value = latest ?? { progressed: false, message: "no transition executed" };
      emit(io, args.json, latest ? humanContinue(latest) : "No transition executed.", value); return 0;
    }
    throw new OrchestrationError("ORCHESTRATION_CLI_INVALID", `Unknown control command '${command}'.`);
  } catch (error) { return fail(io, error, wantsJson); }
}
