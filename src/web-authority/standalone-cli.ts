#!/usr/bin/env node
import { REGISTER_WEB_PACK_USAGE, WEB_PACK_STATUS_USAGE, runRegisterWebPackCommand, runWebPackStatusCommand } from "./web-authority-cli.js";

function usage(): void {
  process.stdout.write("Usage:\n");
  process.stdout.write(`${REGISTER_WEB_PACK_USAGE}\n`);
  process.stdout.write(`${WEB_PACK_STATUS_USAGE}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "register-web-pack") {
    if (!await runRegisterWebPackCommand(args)) { usage(); process.exitCode = 2; }
    return;
  }
  if (command === "web-pack-status") {
    if (!await runWebPackStatusCommand(args)) { usage(); process.exitCode = 2; }
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 3;
});
