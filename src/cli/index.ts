#!/usr/bin/env node

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

function printUsage(): void {
  console.log("Usage:");
  console.log("  wco validate <task-bundle-directory>");
  console.log("  wco intake <task-bundle.zip> --state-dir <directory> [--json]");
  console.log("  wco prepare <task-bundle.zip> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco scan --inbox <directory> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco watch --inbox <directory> --state-dir <directory> --config <config.json> [--jsonl]");
  console.log("  wco execute --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco execution-status --run-id <task-id:archive-sha256> --state-dir <directory> [--json]");
  console.log(PUBLISH_USAGE);
  console.log(DRAFT_PR_USAGE.trim());
  console.log(PACKAGE_RESULT_USAGE.trim());
  console.log(SUBMIT_WEB_VERDICT_USAGE.trim());
  console.log("  wco revise --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> --round <1-3> [--json]");
  console.log("  wco revision-status --run-id <task-id:archive-sha256> --state-dir <directory> [--round <1-3>] [--json]");
  console.log("\nFor the durable Phase 9–16 product flow, use wco-control (or `npm run control -- ...` from a source checkout).");
}

function parseIntakeArguments(args: string[]): { archivePath: string; stateDirectory: string; json: boolean } | null {
  const archivePath = args[0];
  if (!archivePath) return null;
  let stateDirectory: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") { if (json) return null; json = true; continue; }
    if (argument === "--state-dir" && stateDirectory === undefined) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return null;
      stateDirectory = value;
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

async function runValidate(target: string | undefined): Promise<void> {
  if (!target) { printUsage(); process.exitCode = 2; return; }
  const report = await validateBundleDirectory(target);
  for (const check of report.checks) console.log(`✓ ${check}`);
  if (!report.ok) {
    for (const error of report.errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
    return;
  }
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
    if (parsed.json) process.stdout.write(`${JSON.stringify(summary)}\n`); else { console.log(`Discovered ${summary.discovered}; unstable ${summary.unstable}; skipped ${summary.skipped}; ready ${summary.ready_for_codex}; rejected ${summary.rejected}; blocked ${summary.blocked}; failed ${summary.failed}.`); for (const result of summary.results) console.log(`${result.result.toUpperCase()}: ${result.path}${result.error ? ` -> ${result.error.code}: ${result.error.message}` : ""}`); }
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

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "--help" || command === "-h" || command === "help") { printUsage(); return; }
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
  if (command === "revise") { process.exitCode = await runReviseCli(args, { stdout: (value) => process.stdout.write(`${value}\n`), stderr: (value) => process.stderr.write(`${value}\n`) }); return; }
  if (command === "revision-status") { process.exitCode = await runRevisionStatusCli(args, { stdout: (value) => process.stdout.write(`${value}\n`), stderr: (value) => process.stderr.write(`${value}\n`) }); return; }
  printUsage();
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const value = error instanceof Error
    ? process.env.WCO_DEBUG === "1" ? error.stack ?? error.message : error.message
    : String(error);
  console.error(value);
  process.exitCode = 3;
});