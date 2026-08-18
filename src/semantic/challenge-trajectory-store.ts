import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readStableFile } from "../shared/stable-file.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
import type { RepositoryBinding } from "../web-bridge/contracts.js";
import { createSemanticChallengeRequest, type SemanticChallengeRequest } from "./blind-challenge.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_EVENTS = 256;

export type SemanticChallengeTrajectoryEventType = "challenge_created" | "repository_observation" | "understanding_sealed";

export interface SemanticChallengeTrajectoryReceipt {
  schema_version: "1.0";
  kind: "wco-semantic-challenge-trajectory-event";
  challenge_id: string;
  repository: RepositoryBinding;
  original_goal_sha256: string;
  sequence: number;
  event_type: SemanticChallengeTrajectoryEventType;
  idempotency_key_sha256: string;
  payload_sha256: string;
  previous_receipt_sha256: string | null;
  receipt_sha256: string;
}

function digestBytes(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestBytes(canonicalJsonBuffer(value));
}

function safeChallengeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("semantic challenge trajectory challenge identity is invalid.");
  return value;
}

function safeRepositoryId(value: string): string {
  if (!SAFE_REPOSITORY_ID.test(value)) throw new Error("semantic challenge trajectory repository identity is invalid.");
  return value;
}

function safeSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EVENTS) throw new Error(`semantic challenge trajectory sequence must be within 1-${MAX_EVENTS}.`);
  return value;
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

function receiptPayload(receipt: Omit<SemanticChallengeTrajectoryReceipt, "receipt_sha256"> | SemanticChallengeTrajectoryReceipt): unknown {
  return {
    schema_version: receipt.schema_version,
    kind: receipt.kind,
    challenge_id: receipt.challenge_id,
    repository: receipt.repository,
    original_goal_sha256: receipt.original_goal_sha256,
    sequence: receipt.sequence,
    event_type: receipt.event_type,
    idempotency_key_sha256: receipt.idempotency_key_sha256,
    payload_sha256: receipt.payload_sha256,
    previous_receipt_sha256: receipt.previous_receipt_sha256,
  };
}

function challengeDirectory(stateDirectory: string, request: SemanticChallengeRequest): string {
  return path.join(
    path.resolve(stateDirectory),
    "bridge",
    "semantic-challenge-trajectories",
    safeRepositoryId(request.repository.repository_id),
    safeChallengeId(request.challenge_id),
  );
}

async function assertSafeDirectory(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) throw new Error("semantic challenge trajectory directory is unsafe.");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureSafeDirectory(stateDirectory: string, request: SemanticChallengeRequest): Promise<string> {
  const root = path.resolve(stateDirectory);
  await assertSafeDirectory(root);
  const components = [
    "bridge",
    "semantic-challenge-trajectories",
    safeRepositoryId(request.repository.repository_id),
    safeChallengeId(request.challenge_id),
  ];
  let current = root;
  for (const component of components) {
    const parent = current;
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafeDirectory(current);
    await syncDirectory(parent);
    await assertSafeDirectory(parent);
    await assertSafeDirectory(current);
  }
  return current;
}

function parseReceipt(value: unknown, request: SemanticChallengeRequest): SemanticChallengeTrajectoryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic challenge trajectory receipt is malformed.");
  const record = value as Record<string, unknown>;
  const exact = ["schema_version", "kind", "challenge_id", "repository", "original_goal_sha256", "sequence", "event_type", "idempotency_key_sha256", "payload_sha256", "previous_receipt_sha256", "receipt_sha256"];
  if (Object.keys(record).length !== exact.length || exact.some((key) => !(key in record))) throw new Error("semantic challenge trajectory receipt fields are invalid.");
  if (record.schema_version !== "1.0" || record.kind !== "wco-semantic-challenge-trajectory-event" || record.challenge_id !== request.challenge_id) throw new Error("semantic challenge trajectory receipt identity is invalid.");
  const repository = record.repository as RepositoryBinding;
  if (!repository || !sameRepository(repository, request.repository)) throw new Error("semantic challenge trajectory repository binding drifted.");
  const expectedGoal = digestCanonical(request.original_goal);
  if (record.original_goal_sha256 !== expectedGoal) throw new Error("semantic challenge trajectory original goal binding drifted.");
  const sequence = safeSequence(record.sequence as number);
  if (!(record.event_type === "challenge_created" || record.event_type === "repository_observation" || record.event_type === "understanding_sealed")) throw new Error("semantic challenge trajectory event type is invalid.");
  for (const field of ["idempotency_key_sha256", "payload_sha256", "receipt_sha256"] as const) {
    if (typeof record[field] !== "string" || !SHA256.test(record[field] as string)) throw new Error(`semantic challenge trajectory ${field} is invalid.`);
  }
  if (record.previous_receipt_sha256 !== null && (typeof record.previous_receipt_sha256 !== "string" || !SHA256.test(record.previous_receipt_sha256))) throw new Error("semantic challenge trajectory previous receipt digest is invalid.");
  const receipt = record as unknown as SemanticChallengeTrajectoryReceipt;
  if (receipt.receipt_sha256 !== digestCanonical(receiptPayload(receipt))) throw new Error("semantic challenge trajectory receipt digest is invalid.");
  return receipt;
}

async function readReceipt(target: string, request: SemanticChallengeRequest): Promise<SemanticChallengeTrajectoryReceipt> {
  const stable = await readStableFile(target, MAX_RECEIPT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(stable.bytes.toString("utf8")); } catch { throw new Error("semantic challenge trajectory receipt is not valid JSON."); }
  return parseReceipt(parsed, request);
}

async function listReceipts(directory: string, request: SemanticChallengeRequest): Promise<SemanticChallengeTrajectoryReceipt[]> {
  await assertSafeDirectory(directory);
  const names = (await readdir(directory)).filter((name) => /^\d{4}-[a-f0-9]{64}\.json$/.test(name)).sort();
  if (names.length > MAX_EVENTS) throw new Error("semantic challenge trajectory exceeds its event bound.");
  const receipts: SemanticChallengeTrajectoryReceipt[] = [];
  for (const name of names) {
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("semantic challenge trajectory receipt path is unsafe.");
    receipts.push(await readReceipt(target, request));
  }
  let repositoryObservationCount = 0;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    if (receipt.sequence !== index + 1) throw new Error("semantic challenge trajectory sequence is not contiguous.");
    const expectedPrevious = index === 0 ? null : receipts[index - 1]!.receipt_sha256;
    if (receipt.previous_receipt_sha256 !== expectedPrevious) throw new Error("semantic challenge trajectory digest chain is broken.");
    if (receipt.sequence === 1 && receipt.event_type !== "challenge_created") throw new Error("semantic challenge trajectory must begin with challenge_created.");
    if (receipt.sequence > 1 && receipt.event_type === "challenge_created") throw new Error("semantic challenge trajectory cannot create the challenge twice.");
    if (receipt.event_type === "repository_observation") repositoryObservationCount += 1;
    if (receipt.event_type === "understanding_sealed" && repositoryObservationCount < 1) throw new Error("semantic challenge trajectory cannot seal understanding before repository evidence is observed.");
    if (index < receipts.length - 1 && receipt.event_type === "understanding_sealed") throw new Error("semantic challenge trajectory cannot continue after sealed understanding.");
  }
  if (new Set(receipts.map((receipt) => receipt.idempotency_key_sha256)).size !== receipts.length) throw new Error("semantic challenge trajectory contains reused idempotency identity.");
  return receipts;
}

async function writeCreateOnce(target: string, bytes: Buffer, directory: string): Promise<"created" | "replayed"> {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (linked) return "created";
  const existing = await readStableFile(target, MAX_RECEIPT_BYTES);
  if (!existing.bytes.equals(bytes)) throw new Error("semantic challenge trajectory replay conflicts with immutable existing receipt.");
  return "replayed";
}

export async function appendSemanticChallengeTrajectoryEvent(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
  sequence: number;
  eventType: SemanticChallengeTrajectoryEventType;
  idempotencyKey: string;
  payload: unknown;
}): Promise<{ receipt: SemanticChallengeTrajectoryReceipt; status: "created" | "replayed"; path: string }> {
  if (!SAFE_ID.test(options.idempotencyKey)) throw new Error("semantic challenge trajectory idempotency key is invalid.");
  const request = createSemanticChallengeRequest({ challengeId: options.request.challenge_id, repository: options.request.repository, originalGoal: options.request.original_goal });
  const sequence = safeSequence(options.sequence);
  const directory = await ensureSafeDirectory(options.stateDirectory, request);
  const lockRoot = path.join(directory, ".writer-lock");
  let lock;
  try { lock = await acquireTicketFileLock(lockRoot, { timeoutMs: 10_000, pollMs: 25 }); }
  catch (error) {
    if (error instanceof TicketFileLockError) throw new Error(`semantic challenge trajectory writer lock failed: ${error.message}`);
    throw error;
  }
  try {
    const existing = await listReceipts(directory, request);
    const idempotency_key_sha256 = digestBytes(options.idempotencyKey);
    const payload_sha256 = digestCanonical(options.payload);
    const replay = existing.find((receipt) => receipt.idempotency_key_sha256 === idempotency_key_sha256);
    if (replay) {
      if (replay.sequence !== sequence || replay.event_type !== options.eventType || replay.payload_sha256 !== payload_sha256) throw new Error("semantic challenge trajectory idempotency replay conflicts with prior event.");
      const target = path.join(directory, `${String(replay.sequence).padStart(4, "0")}-${replay.idempotency_key_sha256}.json`);
      return { receipt: replay, status: "replayed", path: target };
    }
    if (existing.some((receipt) => receipt.sequence === sequence)) throw new Error("semantic challenge trajectory sequence already belongs to another event.");
    if (sequence !== existing.length + 1) throw new Error("semantic challenge trajectory append must use the next contiguous sequence.");
    if (existing.at(-1)?.event_type === "understanding_sealed") throw new Error("semantic challenge trajectory is already sealed.");
    if (sequence === 1 && options.eventType !== "challenge_created") throw new Error("semantic challenge trajectory first event must be challenge_created.");
    if (sequence > 1 && options.eventType === "challenge_created") throw new Error("semantic challenge trajectory cannot recreate a challenge.");
    if (options.eventType === "understanding_sealed" && !existing.some((receipt) => receipt.event_type === "repository_observation")) throw new Error("semantic challenge trajectory cannot seal understanding before repository evidence is observed.");

    const payload = {
      schema_version: "1.0" as const,
      kind: "wco-semantic-challenge-trajectory-event" as const,
      challenge_id: request.challenge_id,
      repository: request.repository,
      original_goal_sha256: digestCanonical(request.original_goal),
      sequence,
      event_type: options.eventType,
      idempotency_key_sha256,
      payload_sha256,
      previous_receipt_sha256: existing.at(-1)?.receipt_sha256 ?? null,
    };
    const receipt: SemanticChallengeTrajectoryReceipt = { ...payload, receipt_sha256: digestCanonical(payload) };
    const bytes = Buffer.concat([canonicalJsonBuffer(receipt), Buffer.from("\n", "utf8")]);
    if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error("semantic challenge trajectory receipt exceeds its byte bound.");
    const target = path.join(directory, `${String(sequence).padStart(4, "0")}-${idempotency_key_sha256}.json`);
    const status = await writeCreateOnce(target, bytes, directory);
    return { receipt, status, path: target };
  } finally {
    await lock.release();
  }
}

export async function readSemanticChallengeTrajectory(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
}): Promise<SemanticChallengeTrajectoryReceipt[]> {
  const request = createSemanticChallengeRequest({ challengeId: options.request.challenge_id, repository: options.request.repository, originalGoal: options.request.original_goal });
  const directory = challengeDirectory(options.stateDirectory, request);
  try { return await listReceipts(directory, request); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
