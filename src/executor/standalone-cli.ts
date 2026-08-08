#!/usr/bin/env node
import { runExecutorExecuteCli, runExecutorStatusCli } from "./executor-cli.js";

const io = { stdout(value: string) { process.stdout.write(`${value}\n`); }, stderr(value: string) { process.stderr.write(`${value}\n`); } };
const [command, ...args] = process.argv.slice(2);
let code: number;
if (command === "execute") code = await runExecutorExecuteCli(args, io);
else if (command === "status") code = await runExecutorStatusCli(args, io);
else {
  io.stderr("Usage: wco-executor <execute|status> [options]");
  code = 2;
}
process.exitCode = code;
