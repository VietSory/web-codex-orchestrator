import path from "node:path";
import { readArtifactRegistration } from "../web-authority/registry.js";
import { ExecutorError, type ExecutorReceipt } from "./contracts.js";
import { createProductionExecutorGates } from "./production-gates.js";
import { executeRegisteredWebPack } from "./service.js";
import { readExecutorReceipt } from "./store.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface ExecutorCliIo { stdout(value: string): void; stderr(value: string): void; }
export type ExecutorGateFactory = typeof createProductionExecutorGates;

interface CommonArgs { runId: string; artifactSha256: string; stateDirectory: string; json: boolean; }
interface ExecuteArgs extends CommonArgs { configPath: string; }

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new ExecutorError("EXECUTOR_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}
function flags(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Unexpected/duplicate option '${key}'.`);
    if (key === "--json") { values.set(key, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Option '${key}' requires a value.`);
    values.set(key, value); index += 1;
  }
  return values;
}
function required(values: Map<string, string | true>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string" || !value) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Missing required option '${key}'.`);
  return value;
}
function common(argv: string[], includeConfig: boolean): CommonArgs | ExecuteArgs {
  const values = flags(argv);
  const allowed = new Set(["--run-id", "--artifact-sha256", "--state-dir", "--json", ...(includeConfig ? ["--config"] : [])]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Unknown option '${key}'.`);
  const artifactSha256 = required(values, "--artifact-sha256");
  if (!SHA256.test(artifactSha256)) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "--artifact-sha256 must be a lowercase SHA-256 digest.");
  const base: CommonArgs = { runId: required(values, "--run-id"), artifactSha256, stateDirectory: path.resolve(required(values, "--state-dir")), json: values.get("--json") === true };
  splitRunId(base.runId);
  return includeConfig ? { ...base, configPath: path.resolve(required(values, "--config")) } : base;
}
function human(receipt: ExecutorReceipt): string {
  return [`Phase 10 executor: ${receipt.state}`, `Run: ${receipt.run_id}`, `Pack: ${receipt.pack_id}`, `Artifact: ${receipt.artifact_sha256}`, `Change-set: ${receipt.change_set_digest ?? "pending"}`, `Verification: ${receipt.verification.passed ? "PASS" : "pending/failed"}`, `Terra: ${receipt.terra_review.verdict ?? "pending"}`, `Sol: ${receipt.sol_review.verdict ?? "pending"}`].join("\n");
}
function emitError(io: ExecutorCliIo, error: unknown): number {
  const typed = error instanceof ExecutorError ? error : new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", error instanceof Error ? error.message : String(error));
  io.stderr(JSON.stringify({ error: typed.code, message: typed.message }));
  return typed.code === "EXECUTOR_LOCKED" ? 4 : 2;
}

export async function runExecutorExecuteCli(argv: string[], io: ExecutorCliIo, gateFactory: ExecutorGateFactory = createProductionExecutorGates): Promise<number> {
  try {
    const args = common(argv, true) as ExecuteArgs;
    const identity = splitRunId(args.runId);
    const registration = await readArtifactRegistration(args.stateDirectory, identity.taskId, identity.taskBundleSha256, args.artifactSha256);
    if (!registration || registration.run_id !== args.runId) throw new ExecutorError("EXECUTOR_REGISTRATION_NOT_FOUND", "No matching Phase 9 registered Web implementation pack exists.");
    // Runtime/auth/sandbox preflight happens only after cheap authority existence checks,
    // but still before executeRegisteredWebPack can mutate the product worktree.
    const gates = await gateFactory({ runId: args.runId, stateDirectory: args.stateDirectory, configPath: args.configPath });
    const receipt = await executeRegisteredWebPack({ runId: args.runId, artifactSha256: args.artifactSha256, stateDirectory: args.stateDirectory, configPath: args.configPath, verifier: gates.verifier, reviewer: gates.reviewer });
    io.stdout(args.json ? JSON.stringify(receipt) : human(receipt));
    return receipt.state === "READY_FOR_PUBLISH" ? 0 : receipt.state === "ESCALATE_TO_WEB" ? 3 : 2;
  } catch (error) { return emitError(io, error); }
}

export async function runExecutorStatusCli(argv: string[], io: ExecutorCliIo): Promise<number> {
  try {
    const args = common(argv, false) as CommonArgs;
    const identity = splitRunId(args.runId);
    const receipt = await readExecutorReceipt(args.stateDirectory, identity.taskId, identity.taskBundleSha256, args.artifactSha256);
    if (!receipt) { io.stdout(args.json ? "null" : "No Phase 10 executor state found."); return 0; }
    io.stdout(args.json ? JSON.stringify(receipt) : human(receipt));
    return 0;
  } catch (error) { return emitError(io, error); }
}
