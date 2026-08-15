#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { intakeArchive } from "../intake/intake-service.js";
import type { IntakeReceipt } from "../intake/contracts.js";
import { isIntakeError } from "../intake/errors.js";
import { validateBundleDirectory } from "../bundle/validator.js";
import { PreparationError, prepareTask } from "../run/preparation-service.js";
import { CandidatePolicyError } from "../inbox/candidate-policy.js";
import { scanInbox } from "../inbox/scanner.js";
import { watchInbox } from "../inbox/watcher.js";
import { executeRun } from "../execution/execution-service.js";
import { loadExecutionConfig } from "../execution/execution-config.js";
import { executionPaths, readExecutionReceipt } from "../execution/execution-store.js";
import { isExecutionError } from "../execution/errors.js";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { redact } from "../evidence/log-redaction.js";
import { PUBLISH_USAGE, runPublishCommand } from "../publish/publish-cli.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { runDraftPrCommand, DRAFT_PR_USAGE } from "../pull-request/draft-pr-cli.js";
import { runPackageResultCommand, runResultBundleStatusCommand, PACKAGE_RESULT_USAGE } from "../result-bundle/result-bundle-cli.js";
import { runSubmitWebVerdictCommand, runWebReviewStatusCommand, SUBMIT_WEB_VERDICT_USAGE } from "../web-review/web-review-cli.js";
import { runReviseCli, runRevisionStatusCli } from "../revision/revision-cli.js";
import { runControlCommand } from "../orchestration/control-cli.js";
import { formatTaskPreview, previewTaskBundle } from "../preview/task-preview.js";
import { runInteractiveApp } from "../tui/interactive-app.js";
import { terminalIo, type InteractiveIo } from "../tui/session.js";
import { runSetupCommand } from "../setup/setup-cli.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { runWebCommand } from "../web-bridge/web-cli.js";
import { runUninstallCommand } from "../uninstall/uninstall-cli.js";

const CONTROL_COMMANDS = new Set(["doctor", "status", "next", "continue", "pause", "resume"]);

function printUsage(): void {
  console.log("Web Codex Orchestrator (wco)");
  console.log("");
  console.log("Use WCO inside the Git project you want it to work on:");
  console.log("");
  console.log("  cd /path/to/project");
  console.log("  wco");
  console.log("");
  console.log("Then type a software-engineering goal. Type / inside WCO to discover interactive commands.");
  console.log("");
  console.log("Common commands:");
  console.log("  wco                         Open the interactive WCO session");
  console.log("  wco setup                   Register/check the current Git repository");
  console.log("  wco web status              Check ChatGPT authorization");
  console.log("  wco web connect             Authorize or re-authorize ChatGPT");
  console.log("  wco doctor                  Check local prerequisites and readiness");
  console.log("  wco uninstall --purge       Remove WCO-owned local resources");
  console.log("  wco --version               Show the installed WCO version");
  console.log("");
  console.log("Advanced deterministic/protocol commands are still available: wco help advanced");
}

function printAdvancedUsage(): void {
  printUsage();
  console.log("");
  console.log("Advanced deterministic automation:");
  console.log("  wco preview <task-bundle.zip> --state-dir <directory> [--json]");
  console.log("  wco run <task-bundle.zip> --state-dir <directory> --config <config.json> [--web-pack <zip>] [--web-verdict <json>] [--max-transitions <1-32>] [--json]");
  console.log("  wco status --run-id <run-id> --state-dir <directory> [--json]");
  console.log("  wco resume --run-id <run-id> --state-dir <directory> [--json]");
  console.log("  wco doctor --state-dir <directory> --config <config.json> [--json]");
  console.log("");
  console.log("Control and recovery:");
  console.log("  wco next --run-id <run-id> --state-dir <directory> [--json]");
  console.log("  wco continue --run-id <run-id> --state-dir <directory> --config <config.json> [--web-pack <zip>] [--web-verdict <json>] [--max-transitions <1-32>] [--json]");
  console.log("  wco pause --run-id <run-id> --state-dir <directory> [--json]");
  console.log("");
  console.log("Intake and lower-level operations:");
  console.log("  wco validate <task-bundle-directory>");
  console.log("  wco intake <task-bundle.zip> --state-dir <directory> [--json]");
  console.log("  wco prepare <task-bundle.zip> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco scan --inbox <directory> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco watch --inbox <directory> --state-dir <directory> --config <config.json> [--jsonl]");
  console.log("  wco execute --run-id <run-id> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco execution-status --run-id <run-id> --state-dir <directory> [--json]");
  console.log(PUBLISH_USAGE);
  console.log(DRAFT_PR_USAGE.trim());
  console.log(PACKAGE_RESULT_USAGE.trim());
  console.log(SUBMIT_WEB_VERDICT_USAGE.trim());
  console.log("  wco revise --run-id <run-id> --state-dir <directory> --config <config.json> --round <1-3> [--json]");
  console.log("  wco revision-status --run-id <run-id> --state-dir <directory> [--round <1-3>] [--json]");
  console.log("");
  console.log("Routine workflow commands may use WCO_RUN_ID, WCO_STATE_DIR, and WCO_CONFIG instead of repeating the matching flags.");
  console.log("`wco preview` uses WCO_STATE_DIR when --state-dir is omitted.");
  console.log("`wco run` uses WCO_STATE_DIR and WCO_CONFIG when the matching flags are omitted.");
  console.log("Use --json where supported for stable machine-readable output.");
}

async function packageVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

function hasFlag(args: string[], flag: string): boolean { return args.includes(flag); }

function controlArgumentsWithEnvironment(command: string, args: string[]): string[] {
  const resolved = [...args];
  const addDefault = (flag: string, envKey: "WCO_RUN_ID" | "WCO_STATE_DIR" | "WCO_CONFIG"): void => {
    const value = process.env[envKey];
    if (!hasFlag(resolved, flag) && value) resolved.push(flag, value);
  };
  if (command !== "doctor") addDefault("--run-id", "WCO_RUN_ID");
  addDefault("--state-dir", "WCO_STATE_DIR");
  if (command === "doctor" || command === "continue") addDefault("--config", "WCO_CONFIG");
  if (command === "doctor") {
    const paths = resolveWcoPaths({});
    if (!hasFlag(resolved, "--state-dir")) resolved.push("--state-dir", paths.state);
    if (!hasFlag(resolved, "--config")) resolved.push("--config", paths.config);
  }
  return resolved;
}

const controlIo = {
  stdout: (value: string) => process.stdout.write(`${value}\n`),
  stderr: (value: string) => process.stderr.write(`${value}\n`),
};

interface WorkflowRunArguments {
  archivePath: string;
  stateDirectory: string;
  configPath: string;
  webPackPath?: string;
  webVerdictPath?: string;
  maxTransitions: number;
  json: boolean;
}

function parseWorkflowRunArguments(args: string[]): WorkflowRunArguments | null {
  const archivePath = args[0];
  if (!archivePath || archivePath.startsWith("--")) return null;
  let stateDirectory = process.env.WCO_STATE_DIR;
  let configPath = process.env.WCO_CONFIG;
  let webPackPath: string | undefined;
  let webVerdictPath: string | undefined;
  let maxTransitions = 8;
  let json = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (seen.has(argument)) return null;
    if (argument === "--json") { seen.add(argument); json = true; continue; }
    if (!["--state-dir", "--config", "--web-pack", "--web-verdict", "--max-transitions"].includes(argument)) return null;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return null;
    seen.add(argument);
    if (argument === "--state-dir") stateDirectory = value;
    else if (argument === "--config") configPath = value;
    else if (argument === "--web-pack") webPackPath = value;
    else if (argument === "--web-verdict") webVerdictPath = value;
    else {
      maxTransitions = Number(value);
      if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 1 || maxTransitions > 32) return null;
    }
    index += 1;
  }
  if (!stateDirectory || !configPath) return null;
  return { archivePath, stateDirectory, configPath, ...(webPackPath ? { webPackPath } : {}), ...(webVerdictPath ? { webVerdictPath } : {}), maxTransitions, json };
}

async function runWorkflow(args: string[]): Promise<void> {
  const parsed = parseWorkflowRunArguments(args);
  if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const receipt = await prepareTask({ archivePath: parsed.archivePath, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath });
    const forwarded = [
      "--run-id", receipt.run_id,
      "--state-dir", parsed.stateDirectory,
      "--config", parsed.configPath,
      "--max-transitions", String(parsed.maxTransitions),
      ...(parsed.webPackPath ? ["--web-pack", parsed.webPackPath] : []),
      ...(parsed.webVerdictPath ? ["--web-verdict", parsed.webVerdictPath] : []),
      ...(parsed.json ? ["--json"] : []),
    ];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runControlCommand("continue", forwarded, { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) });
    if (parsed.json) {
      const controller = stdout.length > 0 ? JSON.parse(stdout[stdout.length - 1]!) : null;
      if (exitCode === 0) process.stdout.write(`${JSON.stringify({ status: "ok", run_id: receipt.run_id, task_id: receipt.task_id, worktree_path: receipt.worktree_path, controller })}\n`);
      else {
        const controllerError = stderr.length > 0 ? JSON.parse(stderr[stderr.length - 1]!) : { error: "ORCHESTRATION_OPERATIONAL_ERROR", message: "workflow controller failed" };
        process.stdout.write(`${JSON.stringify({ status: "failed", run_id: receipt.run_id, task_id: receipt.task_id, error: controllerError })}\n`);
      }
    } else {
      console.log(`WCO · ${receipt.task_id}`);
      console.log(`Run: ${receipt.run_id}`);
      console.log(`Worktree: ${receipt.worktree_path}`);
      if (stdout.length > 0) console.log(`\n${stdout.join("\n")}`);
      for (const line of stderr) console.error(line);
    }
    process.exitCode = exitCode;
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    const state = statusForError(code);
    if (parsed.json) process.stdout.write(`${JSON.stringify({ status: state, error: { code, message } })}\n`); else console.error(`${code}: ${message}`);
    process.exitCode = state === "failed" ? 3 : 1;
  }
}

function parseIntakeArguments(args: string[], allowStateEnv = false): { archivePath: string; stateDirectory: string; json: boolean } | null {
  const archivePath = args[0];
  if (!archivePath || archivePath.startsWith("--")) return null;
  let stateDirectory: string | undefined = allowStateEnv ? process.env.WCO_STATE_DIR : undefined;
  let stateDirectoryExplicit = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { if (json) return null; json = true; continue; }
    if (argument === "--state-dir") {
      if (stateDirectoryExplicit) return null;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return null;
      stateDirectory = value;
      stateDirectoryExplicit = true;
      index += 1;
      continue;
    }
    return null;
  }
  return stateDirectory ? { archivePath, stateDirectory, json } : null;
}

function printHumanReceipt(receipt: IntakeReceipt): void {
  for (const check of receipt.checks) console.log(`✓ ${check}`);
  if (receipt.status === "accepted") console.log(`\nBundle accepted: ${receipt.stored_bundle}`);
  else {
    for (const error of receipt.errors) {
      const entry = error.entry ? ` (${error.entry})` : "";
      console.error(`✗ ${error.code}: ${error.message}${entry}`);
    }
    console.error("\nBundle rejected.");
  }
}

async function runPreview(args: string[]): Promise<void> {
  const parsed = parseIntakeArguments(args, true);
  if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const preview = await previewTaskBundle(parsed.archivePath, parsed.stateDirectory);
    if (parsed.json) process.stdout.write(`${JSON.stringify(preview)}\n`); else console.log(formatTaskPreview(preview));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) process.stdout.write(`${JSON.stringify({ status: "rejected", error: { code: "PREVIEW_REJECTED", message } })}\n`); else console.error(`PREVIEW_REJECTED: ${message}`);
    process.exitCode = 1;
  }
}

async function runValidate(target: string | undefined): Promise<void> {
  if (!target) { printUsage(); process.exitCode = 2; return; }
  const report = await validateBundleDirectory(target);
  for (const check of report.checks) console.log(`✓ ${check}`);
  if (!report.ok) { for (const error of report.errors) console.error(`✗ ${error}`); process.exitCode = 1; return; }
  console.log("\nBundle contract is valid. Secure intake/preparation still determines execution eligibility.");
}

async function runIntake(args: string[]): Promise<void> {
  const parsed = parseIntakeArguments(args);
  if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const receipt = await intakeArchive(parsed.archivePath, parsed.stateDirectory);
    if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`); else printHumanReceipt(receipt);
    if (receipt.status === "rejected") process.exitCode = receipt.errors.some((error) => error.code === "OPERATIONAL_ERROR") ? 3 : 1;
  } catch (error) {
    const message = isIntakeError(error) ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 3;
  }
}

function parsePrepareArguments(args: string[]): { archivePath: string; stateDirectory: string; configPath: string; json: boolean } | null {
  const archivePath = args[0];
  if (!archivePath) return null;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { if (json) return null; json = true; continue; }
    if ((argument === "--state-dir" || argument === "--config") && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      const value = args[index + 1]!;
      if (argument === "--state-dir") { if (stateDirectory !== undefined) return null; stateDirectory = value; }
      else { if (configPath !== undefined) return null; configPath = value; }
      index += 1; continue;
    }
    return null;
  }
  return stateDirectory && configPath ? { archivePath, stateDirectory, configPath, json } : null;
}

function errorCode(error: unknown): string {
  if (error instanceof PreparationError || error instanceof CandidatePolicyError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "OPERATIONAL_ERROR";
}
function statusForError(code: string): "rejected" | "blocked" | "failed" {
  if (code.startsWith("ZIP_") || code.startsWith("BUNDLE_") || code.startsWith("CHECKSUM_") || code.startsWith("PAYLOAD_") || code === "EXECUTION_CONTRACT_REQUIRED") return "rejected";
  if (["OPERATIONAL_ERROR", "CONFIG_NOT_FOUND", "CONFIG_NOT_REGULAR_FILE", "CONFIG_SYMLINK", "CONFIG_INVALID", "REPOSITORY_PATH_UNSAFE", "REPOSITORY_NOT_GIT", "REPOSITORY_BARE", "REMOTE_NOT_FOUND", "REMOTE_URL_MISMATCH", "FETCH_FAILED", "BASE_COMMIT_NOT_FOUND", "BASE_COMMIT_NOT_ANCESTOR", "BRANCH_ALREADY_EXISTS", "WORKTREE_ALREADY_EXISTS", "WORKTREE_CREATE_FAILED", "WORKTREE_VERIFY_FAILED", "RUN_RECEIPT_INCONSISTENT", "RUN_LOCKED"].includes(code)) return "failed";
  return "blocked";
}

async function runPrepare(args: string[]): Promise<void> {
  const parsed = parsePrepareArguments(args); if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const receipt = await prepareTask({ archivePath: parsed.archivePath, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath });
    if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`); else { for (const check of receipt.checks) console.log(`✓ ${check}`); console.log(`\nPrepared: ${receipt.run_id}`); console.log(`Worktree: ${receipt.worktree_path}`); }
  } catch (error) {
    const code = errorCode(error); const message = error instanceof Error ? error.message : String(error); const state = statusForError(code);
    if (parsed.json) process.stdout.write(`${JSON.stringify({ status: state, error: { code, message } })}\n`); else console.error(`${code}: ${message}`);
    process.exitCode = state === "failed" ? 3 : 1;
  }
}

function parseScanArguments(args: string[]): { inboxDirectory: string; stateDirectory: string; configPath: string; json: boolean } | null {
  let inboxDirectory: string | undefined; let stateDirectory: string | undefined; let configPath: string | undefined; let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]; if (argument === "--json") { if (json) return null; json = true; continue; }
    if ((argument === "--inbox" || argument === "--state-dir" || argument === "--config") && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      const value = args[index + 1]!;
      if (argument === "--inbox") { if (inboxDirectory) return null; inboxDirectory = value; }
      else if (argument === "--state-dir") { if (stateDirectory) return null; stateDirectory = value; }
      else { if (configPath) return null; configPath = value; }
      index += 1; continue;
    }
    return null;
  }
  return inboxDirectory && stateDirectory && configPath ? { inboxDirectory, stateDirectory, configPath, json } : null;
}

async function runScan(args: string[]): Promise<void> {
  const parsed = parseScanArguments(args); if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const summary = await scanInbox(parsed);
    if (parsed.json) process.stdout.write(`${JSON.stringify(summary)}\n`); else { console.log(`Discovered: ${summary.discovered}; unstable ${summary.unstable}; skipped ${summary.skipped}; ready ${summary.ready_for_codex}; rejected ${summary.rejected}; blocked ${summary.blocked}; failed ${summary.failed}.`); for (const result of summary.results) console.log(`${result.result.toUpperCase()}: ${result.path}${result.error ? ` -> ${result.error.code}: ${result.error.message}` : ""}`); }
    if (summary.failed > 0) process.exitCode = 3; else if (summary.rejected > 0 || summary.blocked > 0) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? `${errorCode(error)}: ${error.message}` : String(error)); process.exitCode = 3; }
}

async function runWatch(args: string[]): Promise<void> {
  const parsed = parseScanArguments(args.map((value) => value === "--jsonl" ? "--json" : value)); if (!parsed) { printUsage(); process.exitCode = 2; return; }
  const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await watchInbox({ ...parsed, signal: controller.signal, onScan: async (summary) => { process.stdout.write(`${JSON.stringify(summary)}\n`); } }); }
  catch (error) { console.error(error instanceof Error ? `${errorCode(error)}: ${error.message}` : String(error)); process.exitCode = 3; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

function parseExecutionArguments(args: string[], requireConfig: boolean): { runId: string; stateDirectory: string; configPath?: string; json: boolean } | null {
  let runId: string | undefined; let stateDirectory: string | undefined; let configPath: string | undefined; let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { if (json) return null; json = true; continue; }
    if ((argument === "--run-id" || argument === "--state-dir" || argument === "--config") && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      const value = args[index + 1]!;
      if (argument === "--run-id") { if (runId) return null; runId = value; }
      else if (argument === "--state-dir") { if (stateDirectory) return null; stateDirectory = value; }
      else { if (configPath) return null; configPath = value; }
      index += 1; continue;
    }
    return null;
  }
  if (!runId || !stateDirectory || requireConfig && !configPath) return null;
  return { runId, stateDirectory, ...(configPath !== undefined ? { configPath } : {}), json };
}

function executionExitCode(code: string): number {
  if (["EXECUTION_SCHEMA_UPGRADE_REQUIRED", "EXECUTION_CONFIG_INVALID", "EXECUTION_STATE_INVALID", "POLICY_BLOCKED", "REPLAN_REQUIRED", "WEB_REVIEW_REQUIRED", "HUMAN_REQUIRED", "VERIFICATION_FAILED", "BUDGET_EXHAUSTED"].includes(code)) return 1;
  if (code === "EXECUTION_LOCKED") return 3;
  return 3;
}

async function runExecute(args: string[]): Promise<void> {
  const parsed = parseExecutionArguments(args, true);
  if (!parsed || !parsed.configPath) { printUsage(); process.exitCode = 2; return; }
  const controller = new AbortController(); let signalCode: 130 | 143 | undefined;
  const onSigInt = () => { signalCode = 130; controller.abort(); }; const onSigTerm = () => { signalCode = 143; controller.abort(); };
  process.once("SIGINT", onSigInt); process.once("SIGTERM", onSigTerm);
  try {
    const executionConfig = await loadExecutionConfig(parsed.configPath);
    const runtime = await resolveCodexRuntime(executionConfig.runtime, parsed.stateDirectory);
    const receipt = await executeRun({ runId: parsed.runId, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath, config: executionConfig, agentClient: new CodexSdkAgentClient(runtime), sandbox: new CodexVerificationSandbox(runtime), signal: controller.signal });
    if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    else { console.log(`State: ${receipt.state}`); console.log(`Iterations: ${receipt.implementer.iterations}`); console.log(`Verification rounds: ${receipt.verification.rounds}`); console.log(`Terra reviews: ${receipt.internal_reviewer.rounds} (${receipt.internal_reviewer.verdict ?? "none"})`); console.log(`Sol reviews: ${receipt.final_reviewer.rounds} (${receipt.final_reviewer.verdict ?? "none"})`); console.log(`Artifacts: ${executionPaths(parsed.stateDirectory, receipt.run_id.slice(0, receipt.run_id.lastIndexOf(":")), receipt.run_id.slice(receipt.run_id.lastIndexOf(":") + 1)).directory}`); console.log(receipt.worktree_path); }
    if (receipt.state !== "READY_FOR_PUBLISH") process.exitCode = signalCode ?? executionExitCode(receipt.errors[0]?.code ?? receipt.state);
  } catch (error) {
    const code = isExecutionError(error) ? error.code : "OPERATIONAL_ERROR"; const message = redact(error instanceof Error ? error.message : String(error));
    if (parsed.json) process.stdout.write(`${JSON.stringify({ state: "FAILED", error: { code, message } })}\n`); else process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = signalCode ?? executionExitCode(code);
  } finally { process.removeListener("SIGINT", onSigInt); process.removeListener("SIGTERM", onSigTerm); }
}

async function runExecutionStatus(args: string[]): Promise<void> {
  const parsed = parseExecutionArguments(args, false);
  if (!parsed) { printUsage(); process.exitCode = 2; return; }
  try {
    const separator = parsed.runId.lastIndexOf(":"); if (separator <= 0) throw new Error("Invalid run ID.");
    const receipt = await readExecutionReceipt(parsed.stateDirectory, parsed.runId.slice(0, separator), parsed.runId.slice(separator + 1));
    if (!receipt) { process.exitCode = 3; if (parsed.json) process.stdout.write(`${JSON.stringify({ status: "NOT_FOUND" })}\n`); else process.stderr.write("EXECUTION_RECEIPT_INCONSISTENT: execution receipt not found\n"); return; }
    if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`); else console.log(`State: ${receipt.state}\nIterations: ${receipt.implementer.iterations}\nVerification rounds: ${receipt.verification.rounds}\nTerra reviews: ${receipt.internal_reviewer.rounds} (${receipt.internal_reviewer.verdict ?? "none"})\nSol reviews: ${receipt.final_reviewer.rounds} (${receipt.final_reviewer.verdict ?? "none"})\nArtifacts: ${executionPaths(parsed.stateDirectory, parsed.runId.slice(0, separator), parsed.runId.slice(separator + 1)).directory}`);
  } catch (error) { const code = isExecutionError(error) ? error.code : "OPERATIONAL_ERROR"; const message = redact(error instanceof Error ? error.message : String(error)); if (parsed.json) process.stdout.write(`${JSON.stringify({ status: "FAILED", error: { code, message } })}\n`); else process.stderr.write(`${code}: ${message}\n`); process.exitCode = 3; }
}

function startupInteractiveIo(startupCommand: string): InteractiveIo {
  const io = terminalIo();
  let pending = true;
  return {
    ...io,
    composer: async (prompt, options) => {
      if (pending) {
        pending = false;
        return startupCommand;
      }
      return io.composer ? await io.composer(prompt, options) : await io.question(prompt);
    },
  };
}

async function runInteractiveShortcut(first: string, args: string[]): Promise<boolean> {
  if (first === "--continue") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Interactive WCO shortcuts require a TTY. Run `wco` inside a terminal.\n");
      process.exitCode = 2;
      return true;
    }
    if (args.length !== 1) {
      process.stderr.write("Usage: wco --continue\n");
      process.exitCode = 2;
      return true;
    }
    process.exitCode = await runInteractiveApp(startupInteractiveIo("/continue"));
    return true;
  }
  if (first === "--resume") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Interactive WCO shortcuts require a TTY. Run `wco` inside a terminal.\n");
      process.exitCode = 2;
      return true;
    }
    if (args.length > 2 || args[1] !== undefined && !/^\d+$/u.test(args[1])) {
      process.stderr.write("Usage: wco --resume [history-number]\n");
      process.exitCode = 2;
      return true;
    }
    const startupCommand = args[1] ? `/resume ${args[1]}` : "/resume";
    process.exitCode = await runInteractiveApp(startupInteractiveIo(startupCommand));
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  const first = cliArgs[0];
  if (first !== undefined && await runInteractiveShortcut(first, cliArgs)) return;
  const [command, ...args] = cliArgs;
  if (command === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Interactive WCO requires a TTY. Use an explicit command such as `wco setup --yes`, `wco run ...`, or `wco --help`.\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runInteractiveApp();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") { args[0] === "advanced" ? printAdvancedUsage() : printUsage(); return; }
  if (command === "--version" || command === "-V" || command === "version") { console.log(await packageVersion()); return; }
  if (command === "preview") return runPreview(args);
  if (command === "setup") { process.exitCode = await runSetupCommand(args); return; }
  if (command === "web") { process.exitCode = await runWebCommand(args); return; }
  if (command === "uninstall") { process.exitCode = await runUninstallCommand(args); return; }
  if (command === "run") return runWorkflow(args);
  if (command && CONTROL_COMMANDS.has(command)) { process.exitCode = await runControlCommand(command, controlArgumentsWithEnvironment(command, args), controlIo); return; }
  if (command === "validate") return runValidate(args[0]);
  if (command === "intake") return runIntake(args);
  if (command === "prepare") return runPrepare(args);
  if (command === "scan") return runScan(args);
  if (command === "watch") return runWatch(args);
  if (command === "execute") return runExecute(args);
  if (command === "execution-status") return runExecutionStatus(args);
  if (command === "publish") return runPublishCommand(args, printUsage);
  if (command === "create-draft-pr") { process.exitCode = await runDraftPrCommand(args); return; }
  if (command === "package-result") { process.exitCode = await runPackageResultCommand(args); return; }
  if (command === "result-bundle-status") { process.exitCode = await runResultBundleStatusCommand(args); return; }
  if (command === "submit-web-verdict") { process.exitCode = await runSubmitWebVerdictCommand(args); return; }
  if (command === "web-review-status") { process.exitCode = await runWebReviewStatusCommand(args); return; }
  if (command === "revise") { process.exitCode = await runReviseCli(args, controlIo); return; }
  if (command === "revision-status") { process.exitCode = await runRevisionStatusCli(args, controlIo); return; }
  printUsage();
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const value = error instanceof Error ? process.env.WCO_DEBUG === "1" ? error.stack ?? error.message : error.message : String(error);
  console.error(value);
  process.exitCode = 3;
});
