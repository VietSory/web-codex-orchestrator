#!/usr/bin/env node

import { intakeArchive } from "../intake/intake-service.js";
import type { IntakeReceipt } from "../intake/contracts.js";
import { isIntakeError } from "../intake/errors.js";
import { validateBundleDirectory } from "../bundle/validator.js";

function printUsage(): void {
  console.log("Usage:");
  console.log("  wco validate <task-bundle-directory>");
  console.log("  wco intake <task-bundle.zip> --state-dir <directory> [--json]");
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

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "validate") return runValidate(args[0]);
  if (command === "intake") return runIntake(args);
  printUsage();
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 3;
});
