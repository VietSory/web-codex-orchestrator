import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readStableFile } from "../shared/stable-file.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
import type { RepositoryBinding } from "../web-bridge/contracts.js";
import type { SemanticChallengeEvidence, SemanticChallengeRequest } from "./blind-challenge.js";
import { assertCanonicalByteStrippedChallengeEvidence } from "./challenge-evidence-shape.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATIONS = 128;

export interface SemanticChallengeEvidenceSnapshot {
  schema_version: "1.0";
  kind: "wco-semantic-challenge-evidence-snapshot";
  challenge_id: string;
  repository: RepositoryBinding;
  original_goal_sha256: string;
  observation_count: number;
  trajectory_receipt_sha256: string;
  previous_snapshot_sha256: string | null;
  evidence: SemanticChallengeEvidence;
  snapshot_sha256: string;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex");
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

function safeChallengeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("semantic challenge evidence snapshot challenge identity is invalid.");
  return value;
}

function safeRepositoryId(value: string): string {
  if (!SAFE_REPOSITORY_ID.test(value)) throw new Error("semantic challenge evidence snapshot repository identity is invalid.");
  return value;
}

function safeObservationCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBSERVATIONS) throw new Error(`semantic challenge evidence snapshot observation count must be within 1-${MAX_OBSERVATIONS}.`);
  return value;
}

function evidenceIndexPayload(evidence: SemanticChallengeEvidence): unknown {
  return {
    schema_version: evidence.evidence_index.schema_version,
    kind: evidence.evidence_index.kind,
    repository: evidence.evidence_index.repository,
    observations: evidence.evidence_index.observations,
  };
}

function challengeEvidencePayload(evidence: SemanticChallengeEvidence): unknown {
  return {
    schema_version: evidence.schema_version,
    kind: evidence.kind,
    challenge_id: evidence.challenge_id,
    repository: evidence.repository,
    evidence_index_sha256: evidence.evidence_index.evidence_index_sha256,
  };
}

function assertEvidenceForRequest(evidence: SemanticChallengeEvidence, request: SemanticChallengeRequest): number {
  assertCanonicalByteStrippedChallengeEvidence(evidence);
  if (!evidence || evidence.schema_version !== "1.0" || evidence.kind !== "wco-semantic-challenge-evidence") throw new Error("semantic challenge evidence snapshot requires canonical challenge evidence.");
  if (evidence.challenge_id !== request.challenge_id) throw new Error("semantic challenge evidence snapshot belongs to another challenge.");
  if (!sameRepository(evidence.repository, request.repository) || !sameRepository(evidence.evidence_index.repository, request.repository)) throw new Error("semantic challenge evidence snapshot repository binding drifted.");
  const expectedIndex = digest(evidenceIndexPayload(evidence));
  if (!SHA256.test(evidence.evidence_index.evidence_index_sha256) || evidence.evidence_index.evidence_index_sha256 !== expectedIndex) throw new Error("semantic challenge evidence snapshot index digest is invalid.");
  const expectedEvidence = digest(challengeEvidencePayload(evidence));
  if (!SHA256.test(evidence.challenge_evidence_sha256) || evidence.challenge_evidence_sha256 !== expectedEvidence) throw new Error("semantic challenge evidence snapshot challenge digest is invalid.");
  const count = safeObservationCount(evidence.evidence_index.observations.length);
  for (let index = 0; index < count; index += 1) {
    if (evidence.evidence_index.observations[index]!.sequence !== index + 1) throw new Error("semantic challenge evidence snapshot observations are not contiguous.");
  }
  return count;
}

function snapshotPayload(snapshot: Omit<SemanticChallengeEvidenceSnapshot, "snapshot_sha256"> | SemanticChallengeEvidenceSnapshot): unknown {
  return {
    schema_version: snapshot.schema_version,
    kind: snapshot.kind,
    challenge_id: snapshot.challenge_id,
    repository: snapshot.repository,
    original_goal_sha256: snapshot.original_goal_sha256,
    observation_count: snapshot.observation_count,
    trajectory_receipt_sha256: snapshot.trajectory_receipt_sha256,
    previous_snapshot_sha256: snapshot.previous_snapshot_sha256,
    evidence: snapshot.evidence,
  };
}

function snapshotDirectory(stateDirectory: string, request: SemanticChallengeRequest): string {
  return path.join(path.resolve(stateDirectory), "bridge", "semantic-challenge-evidence", safeRepositoryId(request.repository.repository_id), safeChallengeId(request.challenge_id));
}

async function assertSafeDirectory(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) throw new Error("semantic challenge evidence snapshot directory is unsafe.");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureSafeDirectory(stateDirectory: string, request: SemanticChallengeRequest): Promise<string> {
  const root = path.resolve(stateDirectory);
  await assertSafeDirectory(root);
  const components = ["bridge", "semantic-challenge-evidence", safeRepositoryId(request.repository.repository_id), safeChallengeId(request.challenge_id)];
  let current = root;
  for (const component of components) {
    const parent = current;
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertSafeDirectory(current);
    await syncDirectory(parent);
    await assertSafeDirectory(parent);
    await assertSafeDirectory(current);
  }
  return current;
}

function parseSnapshot(value: unknown, request: SemanticChallengeRequest): SemanticChallengeEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic challenge evidence snapshot is malformed.");
  const record = value as Record<string, unknown>;
  const fields = ["schema_version", "kind", "challenge_id", "repository", "original_goal_sha256", "observation_count", "trajectory_receipt_sha256", "previous_snapshot_sha256", "evidence", "snapshot_sha256"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) throw new Error("semantic challenge evidence snapshot fields are invalid.");
  if (record.schema_version !== "1.0" || record.kind !== "wco-semantic-challenge-evidence-snapshot" || record.challenge_id !== request.challenge_id) throw new Error("semantic challenge evidence snapshot identity is invalid.");
  const snapshot = record as unknown as SemanticChallengeEvidenceSnapshot;
  if (!sameRepository(snapshot.repository, request.repository)) throw new Error("semantic challenge evidence snapshot repository binding drifted.");
  if (snapshot.original_goal_sha256 !== digest(request.original_goal)) throw new Error("semantic challenge evidence snapshot original goal binding drifted.");
  if (!SHA256.test(snapshot.trajectory_receipt_sha256) || (snapshot.previous_snapshot_sha256 !== null && !SHA256.test(snapshot.previous_snapshot_sha256)) || !SHA256.test(snapshot.snapshot_sha256)) throw new Error("semantic challenge evidence snapshot digest field is invalid.");
  const count = assertEvidenceForRequest(snapshot.evidence, request);
  if (snapshot.observation_count !== count) throw new Error("semantic challenge evidence snapshot observation count drifted from evidence.");
  if (snapshot.snapshot_sha256 !== digest(snapshotPayload(snapshot))) throw new Error("semantic challenge evidence snapshot digest is invalid.");
  return snapshot;
}

async function readSnapshot(target: string, request: SemanticChallengeRequest): Promise<SemanticChallengeEvidenceSnapshot> {
  const stable = await readStableFile(target, MAX_SNAPSHOT_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(stable.bytes.toString("utf8")); }
  catch { throw new Error("semantic challenge evidence snapshot is not valid JSON."); }
  return parseSnapshot(parsed, request);
}

async function listSnapshots(directory: string, request: SemanticChallengeRequest): Promise<SemanticChallengeEvidenceSnapshot[]> {
  await assertSafeDirectory(directory);
  const names = (await readdir(directory)).filter((name) => /^\d{4}-[a-f0-9]{64}\.json$/.test(name)).sort();
  if (names.length > MAX_OBSERVATIONS) throw new Error("semantic challenge evidence snapshot count exceeds its bound.");
  const snapshots: SemanticChallengeEvidenceSnapshot[] = [];
  for (const name of names) {
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("semantic challenge evidence snapshot path is unsafe.");
    snapshots.push(await readSnapshot(target, request));
  }
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    if (snapshot.observation_count !== index + 1) throw new Error("semantic challenge evidence snapshots are not contiguous.");
    const previous = index === 0 ? null : snapshots[index - 1]!.snapshot_sha256;
    if (snapshot.previous_snapshot_sha256 !== previous) throw new Error("semantic challenge evidence snapshot chain is broken.");
  }
  return snapshots;
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
    try { await link(temporary, target); linked = true; await syncDirectory(directory); await assertSafeDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  if (linked) {
    const created = await readStableFile(target, MAX_SNAPSHOT_BYTES);
    if (!created.bytes.equals(bytes)) throw new Error("semantic challenge evidence snapshot changed after durable create.");
    return "created";
  }
  const existing = await readStableFile(target, MAX_SNAPSHOT_BYTES);
  if (!existing.bytes.equals(bytes)) throw new Error("semantic challenge evidence snapshot replay conflicts with immutable evidence.");
  return "replayed";
}

async function persistLocked(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
  trajectoryReceiptSha256: string;
  evidence: SemanticChallengeEvidence;
}, directory: string, count: number): Promise<{ snapshot: SemanticChallengeEvidenceSnapshot; path: string; status: "created" | "replayed" }> {
  const existing = await listSnapshots(directory, options.request);
  if (count !== existing.length + 1) {
    const replay = existing.find((snapshot) => snapshot.observation_count === count);
    if (replay && replay.evidence.challenge_evidence_sha256 === options.evidence.challenge_evidence_sha256 && replay.trajectory_receipt_sha256 === options.trajectoryReceiptSha256) {
      const target = path.join(directory, `${String(count).padStart(4, "0")}-${replay.evidence.challenge_evidence_sha256}.json`);
      return { snapshot: replay, path: target, status: "replayed" };
    }
    throw new Error("semantic challenge evidence snapshots must append one exact observation at a time.");
  }
  const payload = {
    schema_version: "1.0" as const,
    kind: "wco-semantic-challenge-evidence-snapshot" as const,
    challenge_id: options.request.challenge_id,
    repository: structuredClone(options.request.repository),
    original_goal_sha256: digest(options.request.original_goal),
    observation_count: count,
    trajectory_receipt_sha256: options.trajectoryReceiptSha256,
    previous_snapshot_sha256: existing.at(-1)?.snapshot_sha256 ?? null,
    evidence: structuredClone(options.evidence),
  };
  const snapshot: SemanticChallengeEvidenceSnapshot = { ...payload, snapshot_sha256: digest(snapshotPayload(payload)) };
  const bytes = Buffer.concat([canonicalJsonBuffer(snapshot), Buffer.from("\n", "utf8")]);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("semantic challenge evidence snapshot exceeds its byte bound.");
  const target = path.join(directory, `${String(count).padStart(4, "0")}-${snapshot.evidence.challenge_evidence_sha256}.json`);
  const status = await writeCreateOnce(target, bytes, directory);
  return { snapshot, path: target, status };
}

export async function persistSemanticChallengeEvidenceSnapshot(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
  trajectoryReceiptSha256: string;
  evidence: SemanticChallengeEvidence;
}): Promise<{ snapshot: SemanticChallengeEvidenceSnapshot; path: string; status: "created" | "replayed" }> {
  if (!SHA256.test(options.trajectoryReceiptSha256)) throw new Error("semantic challenge evidence snapshot trajectory digest is invalid.");
  const count = assertEvidenceForRequest(options.evidence, options.request);
  const directory = await ensureSafeDirectory(options.stateDirectory, options.request);
  let lock;
  try { lock = await acquireTicketFileLock(path.join(directory, ".writer-lock"), { timeoutMs: 10_000, pollMs: 25 }); }
  catch (error) {
    if (error instanceof TicketFileLockError) throw new Error(`semantic challenge evidence snapshot writer lock failed: ${error.message}`);
    throw error;
  }
  try { return await persistLocked(options, directory, count); }
  finally { await lock.release(); }
}

export async function readLatestSemanticChallengeEvidenceSnapshot(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
}): Promise<SemanticChallengeEvidenceSnapshot | null> {
  const directory = snapshotDirectory(options.stateDirectory, options.request);
  try { return (await listSnapshots(directory, options.request)).at(-1) ?? null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
