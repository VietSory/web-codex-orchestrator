import { lstat, mkdir, appendFile, open } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "../run/run-store.js";
import { readRunReceipt } from "../run/run-store.js";
import type { RunReceipt } from "../run/contracts.js";
import { readJsonFile } from "../shared/read-json.js";
import { type ExecutionReceipt, type ExecutionState } from "./contracts.js";
import { isExecutionState } from "./state-machine.js";
import { ExecutionError } from "./errors.js";
import { redact } from "../evidence/log-redaction.js";

const EXECUTION_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const EXECUTION_EVENT_MAX_BYTES = 256 * 1024;
const EXECUTION_EVENT_TAIL_BYTES = EXECUTION_EVENT_MAX_BYTES * 2;

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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt identifiers are unsafe.");
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "execution");
}

export function executionPaths(stateDirectory: string, taskId: string, archiveSha256: string): ExecutionPaths {
  const directory = executionDirectory(stateDirectory, taskId, archiveSha256);
  return { directory, execution: path.join(directory, "execution.json"), events: path.join(directory, "events.jsonl"), implementation: path.join(directory, "implementation"), verification: path.join(directory, "verification"), terraReview: path.join(directory, "terra-review"), solReview: path.join(directory, "sol-review"), evidence: path.join(directory, "evidence"), agentEvents: path.join(directory, "agent-events.jsonl") };
}

async function existingDirectoryChain(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution lifecycle path is not a real directory.");
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

export async function ensureExecutionDirectory(paths: ExecutionPaths): Promise<void> {
  const runsRoot = path.resolve(paths.directory, "../../../");
  const stateRoot = path.dirname(runsRoot);
  const relative = path.relative(stateRoot, paths.directory).split(path.sep).filter(Boolean);
  let current = stateRoot;
  for (const segment of relative) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution lifecycle path is not a real directory.");
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  for (const child of [paths.implementation, paths.verification, paths.terraReview, paths.solReview, paths.evidence]) {
    try { const info = await lstat(child); if (info.isSymbolicLink() || !info.isDirectory()) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution artifact path is not a real directory."); }
    catch (error) { if (error instanceof ExecutionError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(child, { mode: 0o700 }); }
  }
}

async function readRegularJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Receipt must be a regular non-symlink file.");
    return await readJsonFile(filePath, EXECUTION_RECEIPT_MAX_BYTES) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertRegularAppendTarget(filePath: string): Promise<void> {
  const info = await lstat(filePath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution journal must be a regular non-symlink file.");
}

function sanitizeDiagnostic(value: unknown): unknown {
  return Array.isArray(value)
    ? value.slice(0, 256).map(sanitizeDiagnostic)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 64).map(([key, item]) => [key.slice(0, 128), sanitizeDiagnostic(item)]))
      : typeof value === "string"
        ? redact(value).slice(0, 32_768)
        : typeof value === "number" && Number.isFinite(value)
          ? value
          : value === null || typeof value === "boolean"
            ? value
            : undefined;
}

function boundedJournalLine(value: Record<string, unknown>, preserve: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= EXECUTION_EVENT_MAX_BYTES) return `${serialized}\n`;
  return `${JSON.stringify({ ...preserve, truncated: true, original_bytes: bytes })}\n`;
}

async function nextExecutionEventSequence(filePath: string): Promise<number> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const info = await handle.stat();
    if (!info.isFile()) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution journal must be a regular file.");
    if (info.size === 0) return 1;
    const readBytes = Math.min(info.size, EXECUTION_EVENT_TAIL_BYTES);
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await handle.read(buffer, 0, readBytes, info.size - readBytes);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const last = lines.at(-1);
    if (!last) return 1;
    let parsed: unknown;
    try { parsed = JSON.parse(last) as unknown; } catch { throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution journal tail is not valid JSONL."); }
    const sequence = parsed && typeof parsed === "object" ? (parsed as { sequence?: unknown }).sequence : undefined;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution journal tail has an invalid sequence.");
    return (sequence as number) + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readExecutionReceipt(stateDirectory: string, taskId: string, archiveSha256: string): Promise<ExecutionReceipt | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt identifiers are unsafe.");
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  if (!await existingDirectoryChain(paths.directory)) return undefined;
  const receipt = await readRegularJson<ExecutionReceipt>(paths.execution);
  if (receipt === undefined) return undefined;
  const digest = (value: unknown): boolean => value === null || typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const role = (value: unknown): value is { model: string; reasoning_effort: string; thread_id?: string; iterations?: number; rounds?: number; latest_thread_id?: string | null; thread_ids?: string[]; verdict?: string | null; reviewed_change_set_sha256?: string | null } => typeof value === "object" && value !== null && typeof (value as { model?: unknown }).model === "string" && typeof (value as { reasoning_effort?: unknown }).reasoning_effort === "string" && ((value as { thread_ids?: unknown }).thread_ids === undefined || Array.isArray((value as { thread_ids?: unknown }).thread_ids) && (value as { thread_ids: unknown[] }).thread_ids.every((thread) => typeof thread === "string" && thread.length > 0));
  if (!receipt || receipt.execution_version !== "1.0" || receipt.run_id !== `${taskId}:${archiveSha256}` || !isExecutionState(receipt.state) || typeof receipt.base_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.base_commit) || typeof receipt.branch_name !== "string" || typeof receipt.worktree_path !== "string" || typeof receipt.accepted_bundle_path !== "string" || !role(receipt.implementer) || !role(receipt.internal_reviewer) || !role(receipt.final_reviewer) || !receipt.verification || !Array.isArray(receipt.verification.commands) || !Array.isArray(receipt.errors) || !receipt.usage || !digest(receipt.change_set_sha256) || !digest(receipt.repository_refs_sha256 ?? null) || !digest(receipt.verification.verified_change_set_sha256) || !digest(receipt.internal_reviewer.reviewed_change_set_sha256 ?? null) || !digest(receipt.final_reviewer.reviewed_change_set_sha256 ?? null)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt has an invalid schema.");
  const validThread = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
  const validVerdict = (value: unknown): boolean => value === null || value === "APPROVE" || value === "REVISE" || value === "REPLAN" || value === "ESCALATE";
  const validFailureEvidence = (value: unknown): boolean => {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const evidence = value as { verification_round?: unknown; failed_command_ids?: unknown; commands?: unknown; remaining_implementation_iterations?: unknown };
    if (!Number.isInteger(evidence.verification_round) || (evidence.verification_round as number) < 1 || !Number.isInteger(evidence.remaining_implementation_iterations) || (evidence.remaining_implementation_iterations as number) < 0 || !Array.isArray(evidence.failed_command_ids) || evidence.failed_command_ids.length > 256 || !evidence.failed_command_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) || !Array.isArray(evidence.commands) || evidence.commands.length > 256) return false;
    return evidence.commands.every((command) => {
      if (typeof command !== "object" || command === null || Array.isArray(command)) return false;
      const item = command as Record<string, unknown>;
      return typeof item.command_id === "string" && item.command_id.length > 0 && item.command_id.length <= 256 && (item.status === "FAIL" || item.status === "TIMEOUT") && (typeof item.exit_code === "number" && Number.isInteger(item.exit_code) || item.exit_code === null) && (typeof item.signal === "string" && item.signal.length <= 64 || item.signal === null) && typeof item.timed_out === "boolean" && typeof item.stdout_tail === "string" && item.stdout_tail.length <= 8_192 && typeof item.stderr_tail === "string" && item.stderr_tail.length <= 8_192;
    });
  };
  if (!path.isAbsolute(receipt.worktree_path) || !path.isAbsolute(receipt.accepted_bundle_path) || !Number.isInteger(receipt.implementer.iterations) || receipt.implementer.iterations < 0 || !Number.isInteger(receipt.internal_reviewer.rounds) || receipt.internal_reviewer.rounds < 0 || !(receipt.internal_reviewer.latest_thread_id === null || validThread(receipt.internal_reviewer.latest_thread_id)) || !Number.isInteger(receipt.final_reviewer.rounds) || receipt.final_reviewer.rounds < 0 || !(receipt.final_reviewer.latest_thread_id === null || validThread(receipt.final_reviewer.latest_thread_id)) || !validThread(receipt.implementer.thread_id) && receipt.implementer.thread_id !== "" || !validVerdict(receipt.internal_reviewer.verdict) || !validVerdict(receipt.final_reviewer.verdict) || !Number.isInteger(receipt.verification.rounds) || receipt.verification.rounds < 0 || typeof receipt.verification.required_commands_passed !== "boolean" || ![receipt.usage.input_tokens, receipt.usage.cached_input_tokens, receipt.usage.output_tokens].every((value) => Number.isInteger(value) && value >= 0) || receipt.usage.total_turns !== undefined && (!Number.isInteger(receipt.usage.total_turns) || receipt.usage.total_turns < 0) || receipt.usage.started_at !== undefined && typeof receipt.usage.started_at !== "string" || !validFailureEvidence(receipt.pending_verification_failure)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt contains invalid counters or role state.");
  return receipt;
}

export async function writeExecutionReceipt(stateDirectory: string, receipt: ExecutionReceipt): Promise<void> {
  const paths = executionPaths(stateDirectory, receipt.run_id.split(":")[0] ?? receipt.run_id, receipt.run_id.split(":")[1] ?? "");
  await ensureExecutionDirectory(paths);
  await atomicWriteJson(paths.execution, receipt);
}

async function safeArtifactPath(directory: string, fileName: string): Promise<string> {
  if (path.isAbsolute(fileName) || fileName.split(/[\\/]/).includes("..") || fileName.split(/[\\/]/).some((segment) => segment.length === 0 || segment === ".")) throw new ExecutionError("OPERATIONAL_ERROR", "Execution artifact path is unsafe.");
  let current = directory;
  const segments = fileName.split(/[\\/]/);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Execution artifact parent is not a real directory.");
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return path.join(current, segments[segments.length - 1]!);
}

export async function writeExecutionArtifact(stateDirectory: string, taskId: string, archiveSha256: string, relativeName: "implementation" | "verification" | "terra-review" | "sol-review" | "evidence", value: unknown, fileName = "result.json"): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  const directory = paths[relativeName === "terra-review" ? "terraReview" : relativeName === "sol-review" ? "solReview" : relativeName] as string;
  await atomicWriteJson(await safeArtifactPath(directory, fileName), sanitizeDiagnostic(value));
}

export async function writeExecutionText(stateDirectory: string, taskId: string, archiveSha256: string, relativeName: "verification" | "evidence", value: string, fileName: string): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  const directory = paths[relativeName] as string;
  await atomicWriteText(await safeArtifactPath(directory, fileName), redact(value).slice(-32_768));
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
  await assertRegularAppendTarget(paths.events);
  const sequence = await nextExecutionEventSequence(paths.events);
  const base = { event_version: "1.0", run_id: redact(runId), sequence, from, to, timestamp: now().toISOString() };
  await appendFile(paths.events, boundedJournalLine({ ...base, details: sanitizeDiagnostic(details) }, base), { encoding: "utf8", mode: 0o600 });
}

export async function appendAgentEvent(stateDirectory: string, taskId: string, archiveSha256: string, event: Record<string, unknown>): Promise<void> {
  const paths = executionPaths(stateDirectory, taskId, archiveSha256);
  await ensureExecutionDirectory(paths);
  await assertRegularAppendTarget(paths.agentEvents);
  const sanitized = sanitizeDiagnostic(event);
  const sanitizedRecord = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { value: sanitized };
  const eventType = typeof sanitizedRecord.event_type === "string" ? sanitizedRecord.event_type : "agent-event";
  await appendFile(paths.agentEvents, boundedJournalLine(sanitizedRecord, { event_type: eventType }), { encoding: "utf8", mode: 0o600 });
}

export async function readPreparationForExecution(stateDirectory: string, runId: string): Promise<{ receipt: RunReceipt; taskId: string; archiveSha256: string }> {
  const separator = runId.lastIndexOf(":");
  if (separator <= 0) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "run_id must be task-id:archive-sha256.");
  const taskId = runId.slice(0, separator);
  const archiveSha256 = runId.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "run_id contains an unsafe task ID or archive digest.");
  let receipt: RunReceipt | undefined;
  try { receipt = await readRunReceipt(stateDirectory, taskId, archiveSha256); } catch (error) { throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", `Preparation receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
  const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const safeRepositoryId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  if (!receipt || typeof receipt !== "object" || receipt.run_version !== "1.0" || receipt.run_id !== runId || receipt.task_id !== taskId || receipt.archive_sha256 !== archiveSha256 || (receipt.bundle_schema_version !== "1.2" && receipt.bundle_schema_version !== "1.3") || receipt.state !== "READY_FOR_CODEX" || receipt.status !== "READY_FOR_CODEX" || !safeRepositoryId.test(receipt.repository_id) || typeof receipt.repository_path !== "string" || !path.isAbsolute(receipt.repository_path) || typeof receipt.remote !== "string" || typeof receipt.remote_url !== "string" || typeof receipt.base_branch !== "string" || typeof receipt.base_commit !== "string" || !fullCommit.test(receipt.base_commit) || typeof receipt.branch_name !== "string" || typeof receipt.worktree_path !== "string" || !path.isAbsolute(receipt.worktree_path) || typeof receipt.accepted_bundle_path !== "string" || !path.isAbsolute(receipt.accepted_bundle_path) || !Array.isArray(receipt.checks) || !Array.isArray(receipt.errors)) {
    throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Preparation receipt has an invalid schema or identity.");
  }
  return { receipt, taskId, archiveSha256 };
}
