import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError, type OrchestrationEvent, type RunLedger, type TransitionAttemptCounters, type TransitionKind } from "./contracts.js";
import { orchestrationPaths } from "./paths.js";

const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 128;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_CHARS = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const ZERO_HASH = "0".repeat(64);
const TRANSITIONS: TransitionKind[] = ["REGISTER_WEB_PACK","EXECUTE_REGISTERED_PACK","PUBLISH","OPEN_DRAFT_PR","PACKAGE_RESULT","WAIT_WEB_VERDICT","REVISE","WAIT_HUMAN","DONE"];

function emptyAttemptCounters(): TransitionAttemptCounters { return Object.fromEntries(TRANSITIONS.map((value) => [value, 0])) as TransitionAttemptCounters; }

export async function prepareOrchestrationDirectory(stateDirectory: string, directory: string): Promise<void> {
  await fs.mkdir(path.resolve(stateDirectory), { recursive: true, mode: 0o700 });
  const root = await fs.realpath(path.resolve(stateDirectory));
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Orchestration state directory escapes state root.");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: Stats;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", `Unsafe orchestration state ancestor: ${current}`);
  }
  const real = await fs.realpath(target);
  const realRelative = path.relative(root, real);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Orchestration state realpath escapes state root.");
}

async function readStableFile(filePath: string): Promise<Buffer> {
  const pathStat = await fs.lstat(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_LEDGER_BYTES) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger is not a bounded regular non-symlink file.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => { throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", `Cannot safely open run ledger: ${error instanceof Error ? error.message : String(error)}`); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size !== pathStat.size || before.size > MAX_LEDGER_BYTES) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger changed before open.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger truncated while reading."); offset += bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger grew while reading.");
    const afterHandle = await handle.stat(); const afterPath = await fs.lstat(filePath);
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger changed while reading.");
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try { handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag); await handle.sync(); }
  catch (error) { throw new OrchestrationError("ORCHESTRATION_STATE_DURABILITY", `Failed to sync orchestration directory metadata: ${error instanceof Error ? error.message : String(error)}`); }
  finally { await handle?.close().catch(() => undefined); }
}

function hashEvent(event: Omit<OrchestrationEvent, "event_hash">): string { return crypto.createHash("sha256").update(canonicalJsonBuffer(event)).digest("hex"); }

function validateEventChain(ledger: RunLedger): void {
  let previous = ledger.history_anchor_hash; let expectedSequence = ledger.compacted_event_count + 1;
  for (const event of ledger.events) {
    const withoutHash = { sequence: event.sequence, kind: event.kind, at: event.at, data_sha256: event.data_sha256, previous_hash: event.previous_hash };
    if (event.sequence !== expectedSequence || event.previous_hash !== previous || !SHA256.test(event.data_sha256) || event.event_hash !== hashEvent(withoutHash)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger event hash chain is invalid.");
    previous = event.event_hash; expectedSequence += 1;
  }
}

function validateLedger(ledger: RunLedger): void {
  if (ledger.ledger_version !== "1.0" || ledger.run_id !== `${ledger.task_id}:${ledger.task_bundle_sha256}` || !SHA256.test(ledger.task_bundle_sha256) || !SHA256.test(ledger.history_anchor_hash)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger identity is invalid.");
  if (!TRANSITIONS.includes(ledger.next_transition) || ledger.last_completed_transition !== null && !TRANSITIONS.includes(ledger.last_completed_transition)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger transition state is invalid.");
  if (!Number.isSafeInteger(ledger.compacted_event_count) || ledger.compacted_event_count < 0 || ledger.events.length > MAX_EVENTS || ledger.diagnostics.length > MAX_DIAGNOSTICS) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger bounded collections are invalid.");
  if (!Number.isFinite(Date.parse(ledger.created_at)) || !Number.isFinite(Date.parse(ledger.updated_at)) || !Number.isFinite(Date.parse(ledger.budget.started_at))) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger timestamps are invalid.");
  for (const transition of TRANSITIONS) if (!Number.isSafeInteger(ledger.transition_attempts[transition]) || ledger.transition_attempts[transition] < 0) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Per-transition attempt counters are invalid.");
  for (const diagnostic of ledger.diagnostics) if (!diagnostic.code || diagnostic.code.length > 128 || diagnostic.message.length > MAX_DIAGNOSTIC_CHARS || !Number.isSafeInteger(diagnostic.count) || diagnostic.count < 1 || !Number.isFinite(Date.parse(diagnostic.first_at)) || !Number.isFinite(Date.parse(diagnostic.last_at))) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger diagnostic is invalid.");
  for (const value of [ledger.budget.max_attempts_per_transition, ledger.budget.max_total_attempts, ledger.budget.max_elapsed_ms, ledger.budget.max_model_turns, ledger.budget.max_input_tokens, ledger.budget.max_output_tokens, ledger.budget.total_attempts, ledger.budget.model_turns, ledger.budget.input_tokens, ledger.budget.output_tokens]) if (!Number.isSafeInteger(value) || value < 0) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger budget is invalid.");
  if (ledger.current_attempt && (!TRANSITIONS.includes(ledger.current_attempt.transition) || !SHA256.test(ledger.current_attempt.request_sha256) || ledger.current_attempt.result_sha256 !== null && !SHA256.test(ledger.current_attempt.result_sha256) || !Number.isSafeInteger(ledger.current_attempt.attempt_number) || ledger.current_attempt.attempt_number < 1 || typeof ledger.current_attempt.attempt_id !== "string" || ledger.current_attempt.attempt_id.length !== 32)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Current transition attempt is invalid.");
  validateEventChain(ledger);
}

export function createRunLedger(options: { runId: string; nextTransition?: TransitionKind; now?: Date }): RunLedger {
  const split = options.runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(options.runId.slice(split + 1))) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "run_id must be <task-id>:<task-bundle-sha256>.");
  const now = (options.now ?? new Date()).toISOString();
  return { ledger_version: "1.0", run_id: options.runId, task_id: options.runId.slice(0, split), task_bundle_sha256: options.runId.slice(split + 1), status: "ACTIVE", paused: false, pause_reason: null, next_transition: options.nextTransition ?? "REGISTER_WEB_PACK", current_attempt: null, last_completed_transition: null, transition_attempts: emptyAttemptCounters(), budget: { max_attempts_per_transition: 4, max_total_attempts: 24, max_elapsed_ms: 24 * 60 * 60 * 1000, max_model_turns: 32, max_input_tokens: 1_000_000, max_output_tokens: 250_000, total_attempts: 0, model_turns: 0, input_tokens: 0, output_tokens: 0, started_at: now }, retry: { consecutive_failures: 0, next_retry_at: null, circuit_state: "CLOSED", circuit_opened_at: null, last_failure_code: null }, diagnostics: [], history_anchor_hash: ZERO_HASH, compacted_event_count: 0, events: [], created_at: now, updated_at: now };
}

export function appendLedgerEvent(ledger: RunLedger, kind: string, data: unknown, now: Date): void {
  const dataSha = crypto.createHash("sha256").update(canonicalJsonBuffer(data)).digest("hex"); const previousHash = ledger.events.at(-1)?.event_hash ?? ledger.history_anchor_hash;
  const eventWithoutHash = { sequence: ledger.compacted_event_count + ledger.events.length + 1, kind: kind.slice(0, 128), at: now.toISOString(), data_sha256: dataSha, previous_hash: previousHash };
  ledger.events.push({ ...eventWithoutHash, event_hash: hashEvent(eventWithoutHash) });
  while (ledger.events.length > MAX_EVENTS) { const removed = ledger.events.shift()!; ledger.history_anchor_hash = removed.event_hash; ledger.compacted_event_count += 1; }
  ledger.updated_at = now.toISOString();
}

export function recordDiagnostic(ledger: RunLedger, code: string, message: string, now: Date): void {
  const normalizedCode = code.slice(0, 128); const normalizedMessage = message.slice(0, MAX_DIAGNOSTIC_CHARS); const existing = ledger.diagnostics.find((item) => item.code === normalizedCode && item.message === normalizedMessage);
  if (existing) { existing.count += 1; existing.last_at = now.toISOString(); }
  else { ledger.diagnostics.push({ code: normalizedCode, message: normalizedMessage, count: 1, first_at: now.toISOString(), last_at: now.toISOString() }); if (ledger.diagnostics.length > MAX_DIAGNOSTICS) ledger.diagnostics.splice(0, ledger.diagnostics.length - MAX_DIAGNOSTICS); }
  ledger.updated_at = now.toISOString();
}

export async function readRunLedger(stateDirectory: string, runId: string): Promise<RunLedger | null> {
  const split = runId.lastIndexOf(":"); if (split <= 0) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id."); const paths = orchestrationPaths(stateDirectory, runId.slice(0, split), runId.slice(split + 1));
  let bytes: Buffer; try { bytes = await readStableFile(paths.ledger); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger must be an object."); const ledger = parsed as RunLedger; validateLedger(ledger); if (ledger.run_id !== runId) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger path identity does not match its body."); return ledger;
}

export async function writeRunLedger(stateDirectory: string, ledger: RunLedger): Promise<void> {
  validateLedger(ledger); const paths = orchestrationPaths(stateDirectory, ledger.task_id, ledger.task_bundle_sha256); await prepareOrchestrationDirectory(stateDirectory, paths.directory); const bytes = canonicalJsonBuffer(ledger); if (bytes.byteLength > MAX_LEDGER_BYTES) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger exceeds byte cap.");
  const temp = path.join(paths.directory, `.run-ledger.${process.pid}.${crypto.randomUUID()}.tmp`); let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const existing = await fs.lstat(paths.ledger).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error)); if (existing?.isSymbolicLink()) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Run ledger path is a symlink.");
    await fs.rename(temp, paths.ledger); await syncDirectory(paths.directory);
  } finally { await handle?.close().catch(() => undefined); await fs.unlink(temp).catch(() => undefined); }
}
