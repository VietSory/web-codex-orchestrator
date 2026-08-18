import { lstat } from "node:fs/promises";
import path from "node:path";
import { TRUSTED_CONFIG_HARD_LIMITS } from "../config/config-validator.js";
import { atomicWriteJson } from "../run/run-store.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
import { readStableFile } from "../shared/stable-file.js";
import { WebBridgeError } from "./contracts.js";

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ENTRIES = TRUSTED_CONFIG_HARD_LIMITS.agents.maximum_total_agent_turns;
const SHA256 = /^[a-f0-9]{64}$/;

export type ProviderBudgetPhase = "author" | "implementation" | "review";
export interface ProviderBudgetMeasurement {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}
interface ProviderBudgetEntry extends ProviderBudgetMeasurement {
  key: string;
  phase: ProviderBudgetPhase;
  recorded_at: string;
}
interface ProviderBudgetReceipt {
  schema_version: "1.0";
  kind: "wco-provider-budget";
  run_id: string;
  entries: ProviderBudgetEntry[];
}
export interface ProviderBudgetUsage extends ProviderBudgetMeasurement { turns: number; }

function splitRunId(runId: string): { taskId: string; archiveSha: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const archiveSha = runId.slice(split + 1);
  if (split < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !SHA256.test(archiveSha)) {
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget run identity is invalid.");
  }
  return { taskId, archiveSha };
}

function safeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", `Provider budget ${label} is invalid.`);
  }
  return value as number;
}

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget accounting overflowed safe integer bounds.");
  return value;
}

function validateMeasurement(value: ProviderBudgetMeasurement): ProviderBudgetMeasurement {
  const input = safeCount(value.input_tokens, "input tokens");
  const cached = safeCount(value.cached_input_tokens, "cached input tokens");
  const output = safeCount(value.output_tokens, "output tokens");
  const duration = safeCount(value.duration_ms, "duration");
  if (cached > input) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget cached input exceeds total input.");
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, duration_ms: duration };
}

function validateReceipt(value: unknown, runId: string): ProviderBudgetReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget receipt must be an object.");
  const receipt = value as Partial<ProviderBudgetReceipt>;
  if (receipt.schema_version !== "1.0" || receipt.kind !== "wco-provider-budget" || receipt.run_id !== runId || !Array.isArray(receipt.entries) || receipt.entries.length > MAX_ENTRIES) {
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget receipt failed schema validation.");
  }
  const seen = new Set<string>();
  for (const raw of receipt.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget entry is invalid.");
    const entry = raw as ProviderBudgetEntry;
    if (typeof entry.key !== "string" || entry.key.length < 1 || entry.key.length > 512 || /[\r\n\0]/.test(entry.key) || seen.has(entry.key) || !["author", "implementation", "review"].includes(entry.phase) || typeof entry.recorded_at !== "string" || !Number.isFinite(Date.parse(entry.recorded_at))) {
      throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget entry failed identity validation.");
    }
    validateMeasurement(entry);
    seen.add(entry.key);
  }
  return receipt as ProviderBudgetReceipt;
}

function directoryFor(stateDirectory: string, runId: string): string {
  const { taskId, archiveSha } = splitRunId(runId);
  return path.join(path.resolve(stateDirectory), "bridge", "provider-budget", taskId, archiveSha);
}

async function canonicalBudgetDirectory(stateDirectory: string, runId: string): Promise<string> {
  try {
    return await ensureCanonicalDirectory(directoryFor(stateDirectory, runId), "ChatGPT/Codex provider budget state");
  } catch (error) {
    if (error instanceof WebBridgeError) throw error;
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", `Provider budget directory is unsafe: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readReceiptFromDirectory(directory: string, runId: string): Promise<ProviderBudgetReceipt | null> {
  const target = path.join(directory, "usage.json");
  const info = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget receipt path is unsafe or exceeds its bound.");
  try {
    const snapshot = await readStableFile(target, MAX_RECEIPT_BYTES);
    return validateReceipt(JSON.parse(snapshot.bytes.toString("utf8")) as unknown, runId);
  } catch (error) {
    if (error instanceof WebBridgeError) throw error;
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", `Provider budget receipt could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function providerBudgetUsage(receipt: { entries: ProviderBudgetEntry[] }): ProviderBudgetUsage {
  let input = 0, cached = 0, output = 0, duration = 0;
  for (const entry of receipt.entries) {
    const measured = validateMeasurement(entry);
    input = addSafe(input, measured.input_tokens);
    cached = addSafe(cached, measured.cached_input_tokens);
    output = addSafe(output, measured.output_tokens);
    duration = addSafe(duration, measured.duration_ms);
  }
  return { turns: receipt.entries.length, input_tokens: input, cached_input_tokens: cached, output_tokens: output, duration_ms: duration };
}

export async function readProviderBudgetUsage(stateDirectory: string, runId: string): Promise<ProviderBudgetUsage> {
  // Reads attest the complete state ancestry with the same primitive as writes.
  // Creating an empty canonical budget directory is non-authoritative and avoids
  // a weaker "read-only" path that could traverse a symlinked intermediate.
  const directory = await canonicalBudgetDirectory(stateDirectory, runId);
  const receipt = await readReceiptFromDirectory(directory, runId);
  return receipt ? providerBudgetUsage(receipt) : { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0 };
}

export async function recordProviderBudgetUsage(options: {
  stateDirectory: string;
  runId: string;
  key: string;
  phase: ProviderBudgetPhase;
  measurement: ProviderBudgetMeasurement;
  now?: () => Date;
}): Promise<ProviderBudgetUsage> {
  const measurement = validateMeasurement(options.measurement);
  if (typeof options.key !== "string" || options.key.length < 1 || options.key.length > 512 || /[\r\n\0]/.test(options.key)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget idempotency key is invalid.");
  const directory = await canonicalBudgetDirectory(options.stateDirectory, options.runId);
  let lock;
  try { lock = await acquireTicketFileLock(path.join(directory, ".locks"), { timeoutMs: 10_000, pollMs: 25 }); }
  catch (error) {
    if (error instanceof TicketFileLockError) throw new WebBridgeError(error.code === "TICKET_LOCKED" ? "WEB_CHATGPT_CODEX_BUDGET_LOCKED" : "WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", error.message);
    throw error;
  }
  try {
    const receipt = await readReceiptFromDirectory(directory, options.runId) ?? { schema_version: "1.0" as const, kind: "wco-provider-budget" as const, run_id: options.runId, entries: [] };
    const existing = receipt.entries.find((entry) => entry.key === options.key);
    if (existing) {
      const same = existing.phase === options.phase
        && existing.input_tokens === measurement.input_tokens
        && existing.cached_input_tokens === measurement.cached_input_tokens
        && existing.output_tokens === measurement.output_tokens
        && existing.duration_ms === measurement.duration_ms;
      if (!same) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget idempotency key was replayed with different measured usage.");
      return providerBudgetUsage(receipt);
    }
    if (receipt.entries.length >= MAX_ENTRIES) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID", "Provider budget receipt exceeds its bounded turn journal.");
    receipt.entries.push({ key: options.key, phase: options.phase, ...measurement, recorded_at: (options.now?.() ?? new Date()).toISOString() });
    validateReceipt(receipt, options.runId);
    await atomicWriteJson(path.join(directory, "usage.json"), receipt);
    return providerBudgetUsage(receipt);
  } finally {
    await lock.release().catch(() => undefined);
  }
}
