#!/usr/bin/env node
import { runControlCommand } from "./control-cli.js";
const io = { stdout(value: string) { process.stdout.write(`${value}\n`); }, stderr(value: string) { process.stderr.write(`${value}\n`); } };
const [command, ...args] = process.argv.slice(2);
if (!command) { io.stderr("Usage: wco-control <continue|next|status|doctor|pause|resume> [options]"); process.exitCode = 2; } else process.exitCode = await runControlCommand(command, args, io);
