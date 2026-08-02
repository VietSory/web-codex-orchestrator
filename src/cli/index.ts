#!/usr/bin/env node

import { intakeArchive } from "../intake/intake-service.js";
import type { IntakeReceipt } from "../intake/contracts.js";
import { isIntakeError } from "../intake/errors.js";
import { validateBundleDirectory } from "../bundle/validator.js";
import { PreparationError, prepareTask } from "../run/preparation-service.js";
import { CandidatePolicyError } from "../inbox/candidate-policy.js";
import { scanInbox } from "../inbox/scanner.js";
import { watchInbox } from "../inbox/watcher.js";

function printUsage(): void {
  console.log("Usage:");
  console.log("  wco validate <task-bundle-directory>");
  console.log("  wco intake <task-bundle.zip> --state-dir <directory> [--json]");
  console.log("  wco prepare <task-bundle.zip> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco scan --inbox <directory> --state-dir <directory> --config <config.json> [--json]");
  console.log("  wco watch --inbox <directory> --state-dir <directory> --config <config.json> [--jsonl]");
}

function parseIntakeArguments(args: string[]): { archivePath: string; stateDirectory: string; json: boolean } | null {
  const archivePath = args[0];
  if (!archivePath) return null;

  let stateDirectory: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
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
  if (receipt.status === "accepted") {
    console.log(`\nBundle accepted: ${receipt.stored_bundle}`);
  } else {
    for (const error of receipt.errors) {
      const entry = error.entry ? ` (${error.entry})` : "";
      console.error(`✗ ${error.code}: ${error.message}${entry}`);
    }
    console.error("\nBundle rejected.");
  }
}

async function runValidate(target: string | undefined): Promise<void> {
  if (!target) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const report = await validateBundleDirectory(target);
  for (const check of report.checks) console.log(`✓ ${check}`);
  if (!report.ok) {
    for (const error of report.errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nBundle is ready for execution.");
}

async function runIntake(args: string[]): Promise<void> {
  const parsed = parseIntakeArguments(args);
  if (!parsed) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const receipt = await intakeArchive(parsed.archivePath, parsed.stateDirectory);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      printHumanReceipt(receipt);
    }
    if (receipt.status === "rejected") {
      process.exitCode = receipt.errors.some((error) => error.code === "OPERATIONAL_ERROR") ? 3 : 1;
    }
  } catch (error) {
    const message = isIntakeError(error) ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 3;
  }
}

interface Phase3Arguments {
  archivePath: string | undefined;
  inboxDirectory: string | undefined;
  stateDirectory: string;
  configPath: string;
  json: boolean;
  jsonl: boolean;
}

function parsePhase3Arguments(args: string[], mode: "prepare" | "scan" | "watch"): Phase3Arguments | null {
  let archivePath: string | undefined;
  let inboxDirectory: string | undefined;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let json = false;
  let jsonl = false;
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) return null;
    if (argument === "--json") { if (json || jsonl) return null; json = true; continue; }
    if (argument === "--jsonl") { if (json || jsonl) return null; jsonl = true; continue; }
    if (argument === "--state-dir" || argument === "--config" || argument === "--inbox") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (argument === "--state-dir" && stateDirectory === undefined) stateDirectory = value;
      else if (argument === "--config" && configPath === undefined) configPath = value;
      else if (argument === "--inbox" && inboxDirectory === undefined) inboxDirectory = value;
      else return null;
      index += 1;
      continue;
    }
    if (!argument.startsWith("-") && mode === "prepare" && positional === 0) { archivePath = argument; positional += 1; continue; }
    return null;
  }
  if (mode === "prepare" && !archivePath) return null;
  if (mode !== "prepare" && !inboxDirectory) return null;
  if (!stateDirectory || !configPath) return null;
  if (mode !== "watch" && jsonl) return null;
  if (mode === "watch" && json) return null;
  return { archivePath, inboxDirectory, stateDirectory, configPath, json, jsonl };
}

function phase3ExitCode(code: string): number {
  const policyCodes = new Set(["EXECUTION_CONTRACT_REQUIRED", "DELIVERY_CONTRACT_INVALID", "GIT_POLICY_INVALID", "BRANCH_POLICY_VIOLATION", "BASE_COMMIT_INVALID", "FETCH_DISABLED", "REPOSITORY_NOT_REGISTERED", "REMOTE_NOT_ALLOWED", "WORKTREE_PATH_UNSAFE"]);
  return policyCodes.has(code) ? 1 : 3;
}

async function runPrepare(args: string[]): Promise<void> {
  const parsed = parsePhase3Arguments(args, "prepare");
  if (!parsed || !parsed.archivePath) { printUsage(); process.exitCode = 2; return; }
  try {
    const receipt = await prepareTask({ archivePath: parsed.archivePath, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath });
    if (parsed.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    else {
      for (const check of receipt.checks) console.log(`✓ ${check}`);
      console.log(`\n${receipt.status}`);
      console.log(receipt.worktree_path);
    }
  } catch (error) {
    const code = error instanceof PreparationError ? error.code : "OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) process.stdout.write(`${JSON.stringify({ status: "BLOCKED", error: { code, message } })}\n`);
    else console.error(`${code}: ${message}`);
    process.exitCode = phase3ExitCode(code);
  }
}

async function runScan(args: string[]): Promise<void> {
  const parsed = parsePhase3Arguments(args, "scan");
  if (!parsed || !parsed.inboxDirectory) { printUsage(); process.exitCode = 2; return; }
  try {
    const summary = await scanInbox({ inboxDirectory: parsed.inboxDirectory, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed > 0) process.exitCode = 3;
    else if (summary.rejected > 0 || summary.blocked > 0) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof CandidatePolicyError ? error.code : "OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = code === "INBOX_LIMIT_EXCEEDED" ? 1 : 3;
  }
}

async function runWatch(args: string[]): Promise<void> {
  const parsed = parsePhase3Arguments(args, "watch");
  if (!parsed || !parsed.inboxDirectory) { printUsage(); process.exitCode = 2; return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchInbox({ inboxDirectory: parsed.inboxDirectory, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath, signal: controller.signal, onScan: (summary) => {
      if (parsed.jsonl) process.stdout.write(`${JSON.stringify(summary)}\n`);
      else console.log(JSON.stringify(summary));
    }});
  } catch (error) {
    const code = error instanceof CandidatePolicyError ? error.code : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 3;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "validate") return runValidate(args[0]);
  if (command === "intake") return runIntake(args);
  if (command === "prepare") return runPrepare(args);
  if (command === "scan") return runScan(args);
  if (command === "watch") return runWatch(args);
  printUsage();
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 3;
});
