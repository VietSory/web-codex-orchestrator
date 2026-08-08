import { WebAuthorityError } from "./contracts.js";
import { registerWebImplementationPack } from "./authority-service.js";
import { readArtifactRegistration } from "./registry.js";

export const REGISTER_WEB_PACK_USAGE = "  wco-web-authority register --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> --pack <implementation-pack.zip> [--json]";
export const WEB_PACK_STATUS_USAGE = "  wco-web-authority status --run-id <task-id:archive-sha256> --state-dir <directory> --artifact-sha256 <sha256> [--json]";

interface CommonArgs { runId: string; stateDirectory: string; json: boolean; }
interface RegisterArgs extends CommonArgs { configPath: string; packPath: string; }
interface StatusArgs extends CommonArgs { artifactSha256: string; }

function parse(args: string[]): Record<string, string | boolean> | null {
  const result: Record<string, string | boolean> = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (result.json === true) return null;
      result.json = true;
      continue;
    }
    if (!["--run-id", "--state-dir", "--config", "--pack", "--artifact-sha256"].includes(argument ?? "")) return null;
    const value = args[index + 1];
    if (!value || value.startsWith("--") || result[argument!] !== undefined) return null;
    result[argument!] = value;
    index += 1;
  }
  return result;
}

function parseRegister(args: string[]): RegisterArgs | null {
  const parsed = parse(args);
  if (!parsed) return null;
  const runId = parsed["--run-id"];
  const stateDirectory = parsed["--state-dir"];
  const configPath = parsed["--config"];
  const packPath = parsed["--pack"];
  if (typeof runId !== "string" || typeof stateDirectory !== "string" || typeof configPath !== "string" || typeof packPath !== "string" || parsed["--artifact-sha256"] !== undefined) return null;
  return { runId, stateDirectory, configPath, packPath, json: parsed.json === true };
}

function parseStatus(args: string[]): StatusArgs | null {
  const parsed = parse(args);
  if (!parsed) return null;
  const runId = parsed["--run-id"];
  const stateDirectory = parsed["--state-dir"];
  const artifactSha256 = parsed["--artifact-sha256"];
  if (typeof runId !== "string" || typeof stateDirectory !== "string" || typeof artifactSha256 !== "string" || parsed["--config"] !== undefined || parsed["--pack"] !== undefined) return null;
  return { runId, stateDirectory, artifactSha256, json: parsed.json === true };
}

function printError(error: unknown, json: boolean): void {
  const code = error instanceof WebAuthorityError ? error.code : "WEB_AUTHORITY_OPERATIONAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  if (json) process.stdout.write(`${JSON.stringify({ state: "FAILED", error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = code === "WEB_AUTHORITY_OPERATIONAL_ERROR" ? 3 : 1;
}

export async function runRegisterWebPackCommand(args: string[]): Promise<boolean> {
  const parsed = parseRegister(args);
  if (!parsed) return false;
  try {
    const record = await registerWebImplementationPack({ runId: parsed.runId, stateDirectory: parsed.stateDirectory, configPath: parsed.configPath, archivePath: parsed.packPath });
    if (parsed.json) process.stdout.write(`${JSON.stringify(record)}\n`);
    else {
      process.stdout.write(`Registered Web implementation pack: ${record.artifact_sha256}\n`);
      process.stdout.write(`Run: ${record.run_id}\n`);
      process.stdout.write(`Stored: ${record.stored_relative_path}\n`);
    }
  } catch (error) { printError(error, parsed.json); }
  return true;
}

export async function runWebPackStatusCommand(args: string[]): Promise<boolean> {
  const parsed = parseStatus(args);
  if (!parsed) return false;
  const split = parsed.runId.lastIndexOf(":");
  if (split <= 0) { printError(new WebAuthorityError("WEB_AUTHORITY_INVALID_RUN_ID", "Invalid run ID."), parsed.json); return true; }
  try {
    const record = await readArtifactRegistration(parsed.stateDirectory, parsed.runId.slice(0, split), parsed.runId.slice(split + 1), parsed.artifactSha256);
    if (!record) {
      if (parsed.json) process.stdout.write(`${JSON.stringify({ state: "NOT_FOUND", artifact_sha256: parsed.artifactSha256 })}\n`);
      else process.stdout.write("Web implementation pack is not registered.\n");
      process.exitCode = 1;
      return true;
    }
    if (parsed.json) process.stdout.write(`${JSON.stringify({ state: "REGISTERED", registration: record })}\n`);
    else {
      process.stdout.write("State: REGISTERED\n");
      process.stdout.write(`Artifact: ${record.artifact_sha256}\n`);
      process.stdout.write(`Pack: ${record.pack_id}\n`);
    }
  } catch (error) { printError(error, parsed.json); }
  return true;
}