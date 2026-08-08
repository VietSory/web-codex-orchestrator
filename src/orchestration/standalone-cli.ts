#!/usr/bin/env node
import { runControlCommand } from "./control-cli.js";

const io = {
  stdout(value: string) { process.stdout.write(`${value}\n`); },
  stderr(value: string) { process.stderr.write(`${value}\n`); },
};

function usage(): void {
  io.stdout("Usage:");
  io.stdout("  wco-control doctor --state-dir <directory> --config <config.json> [--json]");
  io.stdout("  wco-control status --run-id <task-id:sha256> --state-dir <directory> [--json]");
  io.stdout("  wco-control next --run-id <task-id:sha256> --state-dir <directory> [--json]");
  io.stdout("  wco-control continue --run-id <task-id:sha256> --state-dir <directory> --config <config.json> [--web-pack <pack.zip>] [--web-verdict <verdict.json>] [--max-transitions <1..32>] [--json]");
  io.stdout("  wco-control pause|resume --run-id <task-id:sha256> --state-dir <directory> [--json]");
}

const [command, ...args] = process.argv.slice(2);
if (command === "--help" || command === "-h" || command === "help") {
  usage();
  process.exitCode = 0;
} else if (!command) {
  usage();
  process.exitCode = 2;
} else {
  process.exitCode = await runControlCommand(command, args, io);
}
