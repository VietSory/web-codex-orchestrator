import { lstat, mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../run/run-store.js";
import { readRunReceipt } from "../run/run-store.js";
import type { RunReceipt } from "../run/contracts.js";
import type { ExecutionReceipt, ExecutionState } from "./contracts.js";
import { ExecutionError } from "./errors.js";
import { redact } from "../evidence/log-redaction.js";

export interface ExecutionPaths {
  directory: string;
  execution: string;
  events: string;
  implementation: string;
  verification: string;
  terraReview: string;
  solReview: string;
  evidence: string;
  agentEvents: string;
}

export function executionDirectory(stateDirectory: string, taskId: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "execution");
}

export function executionPaths(stateDirectory: string, taskId: string, archiveSha256: string): ExecutionPaths {
  const directory = executionDirectory(stateDirectory, taskId, archiveSha256);
  return { directory, execution: path.join(directory, "execution.json"), events: path.join(directory, "events.jsonl"), implementation: path.join(directory, "implementation"), verification: path.join(directory, "verification"), terraReview: path.join(directory, "terra-review"), solReview: path.join(directory, "sol-review"), evidence: path.join(directory, "evidence"), agentEvents: path.join(directory, "agent-events.jsonl") };
}

export async function ensureExecutionDirectory(paths: ExecutionPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  for (const child of [paths.implementation, paths.verification, paths.terraReview, paths.solReview, paths.evidence]) await mkdir(child, { recursive: true, mode: 0o700 });
}

async function readRegularJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Receipt must be a regular non-symlink file.");
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readExecutionReceipt(stateDirectory: string, taskId: string, archiveSha256: string): Promise<ExecutionReceipt | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt identifiers are unsafe.");
  return readRegularJson<ExecutionReceipt>(executionPaths(stateDirectory, taskId, archiveSha256).execution);
}

export async function writeExecutionReceipt(stateDirectory: string, receipt: ExecutionReceipt): Promise<void> {
  const paths = executionPaths(stateDirectory, receipt.run_id.split(":")[0] ?? receipt.run_id, receipt.run_id.split(":")[1] ?? "");
  await ensureExecutionDirectory(paths);
  await atomicWriteJson(paths.execution, receipt);
}

export async function writeExecutionArtifact(stateDirectory: string, taskId: string, archiveSha256: string, relativeName: "implementation" | "verification" | "terra-review" | "sol-review" | "evidence", value: unknown, fileName = "result.json"): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  const directory = paths[relativeName === "terra-review" ? "terraReview" : relativeName === "sol-review" ? "solReview" : relativeName] as string;
  const sanitize = (input: unknown): unknown => Array.isArray(input) ? input.map(sanitize) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, sanitize(item)])) : typeof input === "string" ? redact(input).slice(0, 32_768) : input;
  await atomicWriteJson(path.join(directory, fileName), sanitize(value));
}

export async function appendExecutionEvent(
  stateDirectory: string,
  taskId: string,
  archiveSha256: string,
  runId: string,
  from: ExecutionState,
  to: ExecutionState,
  details: Record<string, unknown> = {},
  now = () => new Date(),
): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  let sequence = 1;
  try { sequence = (await readFile(paths.events, "utf8")).split(/\r?\n/).filter(Boolean).length + 1; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await appendFile(paths.events, `${JSON.stringify({ event_version: "1.0", run_id: runId, sequence, from, to, timestamp: now().toISOString(), details })}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function appendAgentEvent(stateDirectory: string, taskId: string, archiveSha256: string, event: Record<string, unknown>): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  await appendFile(paths.agentEvents, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readPreparationForExecution(stateDirectory: string, runId: string): Promise<{ receipt: RunReceipt; taskId: string; archiveSha256: string }> {
  const separator = runId.lastIndexOf(":");
  if (separator <= 0) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "run_id must be task-id:archive-sha256.");
  const taskId = runId.slice(0, separator);
  const archiveSha256 = runId.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "run_id contains an unsafe task ID or archive digest.");
  let receipt: RunReceipt | undefined;
  try { receipt = await readRunReceipt(stateDirectory, taskId, archiveSha256); } catch (error) { throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", `Preparation receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
  if (!receipt || receipt.run_id !== runId || receipt.state !== "READY_FOR_CODEX") throw new ExecutionError("EXECUTION_STATE_INVALID", "Preparation receipt is not READY_FOR_CODEX.");
  return { receipt, taskId, archiveSha256 };
}
