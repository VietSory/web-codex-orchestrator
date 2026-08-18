import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { readStableFile } from "../shared/stable-file.js";
import type { RepositoryBinding } from "../web-bridge/contracts.js";
import { buildSemanticEvidenceIndex, type SemanticEvidenceObservationInput } from "./evidence-index.js";

const SAFE_SESSION_ID = /^[0-9a-f-]{36}$/i;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RECEIPT_BYTES = 1_100_000;

export interface SemanticShadowReceipt {
  schema_version: "1.0";
  kind: "wco-semantic-shadow-observation";
  session_id: string;
  repository: RepositoryBinding;
  event_sequence: number;
  request_id_sha256: string;
  evidence_index: ReturnType<typeof buildSemanticEvidenceIndex>;
  receipt_sha256: string;
}

function digestBytes(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestBytes(canonicalJsonBuffer(value));
}

function safeSessionId(value: string): string {
  if (!SAFE_SESSION_ID.test(value)) throw new Error("semantic shadow session identity is invalid.");
  return value.toLowerCase();
}

function safeRepositoryId(value: string): string {
  if (!SAFE_REPOSITORY_ID.test(value)) throw new Error("semantic shadow repository identity is invalid.");
  return value;
}

function safeSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("semantic shadow event sequence is invalid.");
  return value;
}

function receiptDirectory(stateDirectory: string, repositoryId: string, sessionId: string): string {
  return path.join(path.resolve(stateDirectory), "bridge", "semantic-shadow", safeRepositoryId(repositoryId), safeSessionId(sessionId));
}

export function semanticShadowReceiptPath(options: { stateDirectory: string; repositoryId: string; sessionId: string; eventSequence: number; requestId: string }): string {
  const requestHash = digestBytes(options.requestId);
  return path.join(receiptDirectory(options.stateDirectory, options.repositoryId, options.sessionId), `${String(safeSequence(options.eventSequence)).padStart(12, "0")}-${requestHash}.json`);
}

function buildReceipt(options: {
  sessionId: string;
  repository: RepositoryBinding;
  eventSequence: number;
  requestId: string;
  command: unknown;
  result: unknown;
}): SemanticShadowReceipt {
  const session_id = safeSessionId(options.sessionId);
  const event_sequence = safeSequence(options.eventSequence);
  const observation: SemanticEvidenceObservationInput = {
    sequence: event_sequence,
    request_id: options.requestId,
    command: options.command,
    result: options.result,
  };
  const evidence_index = buildSemanticEvidenceIndex({ repository: options.repository, observations: [observation] });
  const payload = {
    schema_version: "1.0" as const,
    kind: "wco-semantic-shadow-observation" as const,
    session_id,
    repository: evidence_index.repository,
    event_sequence,
    request_id_sha256: digestBytes(options.requestId),
    evidence_index,
  };
  const receipt_sha256 = digestCanonical(payload);
  const receipt = { ...payload, receipt_sha256 };
  if (canonicalJsonBuffer(receipt).byteLength > MAX_RECEIPT_BYTES) throw new Error("semantic shadow receipt exceeds its byte bound.");
  return receipt;
}

async function assertSafeDirectory(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) throw new Error("semantic shadow receipt directory is unsafe.");
}

async function ensureSafeReceiptDirectory(stateDirectory: string, repositoryId: string, sessionId: string): Promise<string> {
  const root = path.resolve(stateDirectory);
  // State root is authority supplied by the caller and must already exist; only
  // managed descendants may be created by the non-authoritative shadow path.
  await assertSafeDirectory(root);
  const directory = await ensureCanonicalDirectory(receiptDirectory(root, repositoryId, sessionId), "semantic shadow receipt");
  await assertSafeDirectory(root);
  return directory;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeCreateOnce(target: string, bytes: Buffer, stateDirectory: string, repositoryId: string, sessionId: string): Promise<"created" | "replayed"> {
  const directory = await ensureSafeReceiptDirectory(stateDirectory, repositoryId, sessionId);
  if (directory !== path.dirname(target)) throw new Error("semantic shadow receipt target escaped its attested directory.");
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let linked = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await assertSafeDirectory(directory);
    try {
      await link(temporary, target);
      linked = true;
      await syncDirectory(directory);
      await assertSafeDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (linked) {
    const created = await readStableFile(target, MAX_RECEIPT_BYTES);
    if (!created.bytes.equals(bytes)) throw new Error("semantic shadow receipt changed after durable create.");
    return "created";
  }
  await assertSafeDirectory(directory);
  const existing = await readStableFile(target, MAX_RECEIPT_BYTES);
  if (!existing.bytes.equals(bytes)) throw new Error("semantic shadow receipt replay conflicts with immutable existing evidence.");
  return "replayed";
}

export async function persistSemanticShadowObservation(options: {
  stateDirectory: string;
  sessionId: string;
  repository: RepositoryBinding;
  eventSequence: number;
  requestId: string;
  command: unknown;
  result: unknown;
}): Promise<{ receipt: SemanticShadowReceipt; path: string; status: "created" | "replayed" }> {
  const receipt = buildReceipt(options);
  const target = semanticShadowReceiptPath({
    stateDirectory: options.stateDirectory,
    repositoryId: receipt.repository.repository_id,
    sessionId: receipt.session_id,
    eventSequence: receipt.event_sequence,
    requestId: options.requestId,
  });
  const bytes = Buffer.concat([canonicalJsonBuffer(receipt), Buffer.from("\n", "utf8")]);
  const status = await writeCreateOnce(target, bytes, options.stateDirectory, receipt.repository.repository_id, receipt.session_id);
  return { receipt, path: target, status };
}
