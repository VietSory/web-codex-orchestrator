#!/usr/bin/env node

import { validateBundleDirectory } from "../bundle/validator.js";

function printUsage(): void {
  console.log("Usage:");
  console.log("  wco validate <task-bundle-directory>");
}

async function main(): Promise<void> {
  const [, , command, target] = process.argv;

  if (command !== "validate" || !target) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const report = await validateBundleDirectory(target);

  for (const check of report.checks) {
    console.log(`✓ ${check}`);
  }

  if (!report.ok) {
    for (const error of report.errors) {
      console.error(`✗ ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nBundle is ready for execution.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
