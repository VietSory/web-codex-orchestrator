import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REVIEWER, type ReviewerSelection } from "../agent/reviewer-selection.js";
import { freezeRunReviewMode, readReviewMode } from "../agent/reviewer-mode-store.js";
import type { TrustedConfig } from "../config/contracts.js";
import type { JobMode } from "../orchestration/job-mode.js";
import { atomicWriteJson } from "../run/run-store.js";
import { prepareTask } from "../run/preparation-service.js";
import { persistSemanticShadowObservation } from "../semantic/shadow-observer.js";
import { contentDigest, parseWebContractEnvelope, WebBridgeError, type RepositoryBinding, type WebContractEnvelope } from "./contracts.js";
import type { WebBridge } from "./web-bridge.js";
import { ExactRepositoryReadService } from "./repo-read-service.js";
import { ReadCoverageStore } from "./read-coverage-store.js";
import { materializeTaskBundle } from "./task-contract-materializer.js";
import { materializeWebImplementationPack } from "./web-pack-materializer.js";
import { ContentAddressedContextCache } from "./context-cache.js";
import { isPreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import { archiveLocalTaskHistory } from "./session-history.js";

const SESSION_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_STATES = new Set(["CREATING", "AUTHORING", "CONTRACT_SEALED", "PREPARED", "IMPLEMENTATION_REGISTERED", "COMPLETED", "BLOCKED"]);
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalWorkerSession {
  schema_version: "1.0";
  session_id: string;
  repository: RepositoryBinding;
  goal: string;
  job_mode?: JobMode;
  reviewer_selection?: ReviewerSelection;
  job_id: string | null;
  last_event_sequence: number;
  sealed: boolean;
  contract: WebContractEnvelope | null;
  task_archive_path: string | null;
  run_id: string | null;
  web_pack_path: string | null;
  state: "CREATING" | "AUTHORING" | "CONTRACT_SEALED" | "PREPARED" | "IMPLEMENTATION_REGISTERED" | "COMPLETED" | "BLOCKED";
  created_at: string;
  updated_at: string;
}

function sessionPath(stateDirectory: string, repositoryId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repositoryId)) throw new WebBridgeError("WEB_SESSION_ID_INVALID", "Repository identity is invalid.");
  return path.join(stateDirectory, "bridge", "sessions", `${repositoryId}.json`);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validateSession(value: unknown, repositoryId: string): LocalWorkerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session must be an object.");
  const session = value as LocalWorkerSession;
  if (session.schema_version !== "1.0" || typeof session.session_id !== "string" || !/^[0-9a-f-]{36}$/i.test(session.session_id) || !session.repository || session.repository.repository_id !== repositoryId || !/^[a-f0-9]{40}$/.test(session.repository.base_commit) || typeof session.repository.base_branch !== "string" || !session.repository.base_branch || typeof session.goal !== "string" || !session.goal || session.goal.length > 65_536 || !Number.isSafeInteger(session.last_event_sequence) || session.last_event_sequence < 0 || typeof session.sealed !== "boolean" || !SESSION_STATES.has(session.state) || !Number.isFinite(Date.parse(session.created_at)) || !Number.isFinite(Date.parse(session.updated_at))) {
    throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session failed durable schema/identity validation.");
  }
  if (session.job_mode !== undefined && session.job_mode !== "PAIR" && session.job_mode !== "AUTOPILOT") throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session has an invalid orchestration mode.");
  if (session.job_id !== null && (typeof session.job_id !== "string" || !JOB_ID.test(session.job_id))) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session has an invalid authoring job identity.");
  for (const field of [session.task_archive_path, session.web_pack_path]) if (field !== null && (typeof field !== "string" || !path.isAbsolute(field))) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session contains a non-absolute artifact path.");
  if (session.run_id !== null && (typeof session.run_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/.test(session.run_id))) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session has an invalid canonical run identity.");
  if (session.contract !== null) {
    const contract = parseWebContractEnvelope(session.contract);
    if (session.job_id === null || contract.job_id !== session.job_id || contract.user_intent !== session.goal || contentDigest(contract.repository) !== contentDigest(session.repository)) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session contract does not bind its original job, intent, and repository.");
    session.contract = contract;
  }
  if (session.sealed && !session.contract) throw new WebBridgeError("WEB_SESSION_INVALID", "Sealed local worker session is missing its exact contract.");
  if (["PREPARED", "IMPLEMENTATION_REGISTERED", "COMPLETED"].includes(session.state) && (!session.sealed || !session.run_id || !session.task_archive_path)) throw new WebBridgeError("WEB_SESSION_INVALID", "Prepared local worker session is missing canonical authority.");
  if (session.state === "IMPLEMENTATION_REGISTERED" && !session.web_pack_path) throw new WebBridgeError("WEB_SESSION_INVALID", "Implementation-registered session is missing its exact Web pack.");
  return session;
}

export function localWorkerJobMode(session: Pick<LocalWorkerSession, "job_mode">): JobMode {
  return session.job_mode ?? "PAIR";
}

export async function readLocalWorkerSession(stateDirectory: string, repositoryId: string): Promise<LocalWorkerSession | null> {
  const target = sessionPath(stateDirectory, repositoryId);
  const pathStat = await lstat(target).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!pathStat) return null;
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > SESSION_MAX_BYTES || await realpath(target) !== target) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session path is unsafe or exceeds its bound.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(target, fsConstants.O_RDONLY | noFollow).catch((error) => { throw new WebBridgeError("WEB_SESSION_INVALID", `Local worker session could not be opened safely: ${error instanceof Error ? error.message : String(error)}`); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathStat, before) || before.size > SESSION_MAX_BYTES) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session changed before stable open.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session truncated during read."); offset += bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session grew during read.");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(target)]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath)) throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session changed during read.");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw new WebBridgeError("WEB_SESSION_INVALID", "Local worker session is not valid JSON."); }
    return validateSession(parsed, repositoryId);
  } finally { await handle.close(); }
}

async function save(stateDirectory: string, value: LocalWorkerSession): Promise<void> {
  await mkdir(path.dirname(sessionPath(stateDirectory, value.repository.repository_id)), { recursive: true, mode: 0o700 });
  value.updated_at = new Date().toISOString();
  validateSession(value, value.repository.repository_id);
  await atomicWriteJson(sessionPath(stateDirectory, value.repository.repository_id), value);
}

export async function startLocalAuthoring(options: {
  bridge: WebBridge;
  repository: RepositoryBinding;
  goal: string;
  stateDirectory: string;
  owner?: string;
  now?: () => Date;
  replaceExplicit?: boolean;
  mode?: JobMode;
  reviewerSelection?: ReviewerSelection;
}): Promise<LocalWorkerSession> {
  const existing = await readLocalWorkerSession(options.stateDirectory, options.repository.repository_id);
  if (existing && existing.state !== "BLOCKED" && existing.state !== "COMPLETED" && !options.replaceExplicit) {
    throw new WebBridgeError("WEB_TASK_ALREADY_ACTIVE", "A task is already active for this repository. Use explicit /new or /auto to replace the local task focus; existing durable runs remain preserved.");
  }
  if (existing) await archiveLocalTaskHistory(options.stateDirectory, existing);

  const now = options.now?.() ?? new Date();
  const mode = options.mode ?? "PAIR";
  const reviewerSelection = options.reviewerSelection ?? await readReviewMode(options.stateDirectory);
  const session: LocalWorkerSession = {
    schema_version: "1.0",
    session_id: crypto.randomUUID(),
    repository: options.repository,
    goal: options.goal,
    job_mode: mode,
    reviewer_selection: reviewerSelection,
    job_id: null,
    last_event_sequence: 0,
    sealed: false,
    contract: null,
    task_archive_path: null,
    run_id: null,
    web_pack_path: null,
    state: "CREATING",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await save(options.stateDirectory, session);

  let identity;
  try {
    identity = await options.bridge.createAuthoringJob({
      owner: options.owner ?? "local",
      repository: options.repository,
      user_intent: options.goal,
      ttl_seconds: 86_400,
      orchestration_mode: mode,
    }, `author-${session.session_id}`);
  } catch (error) {
    // Keep the pre-external-call CREATING receipt as a crash-recovery anchor,
    // but never leave it looking active after a known bridge/auth failure.
    // BLOCKED is intentionally replaceable by the next normal goal.
    session.state = "BLOCKED";
    try {
      await save(options.stateDirectory, session);
    } catch (saveError) {
      throw new WebBridgeError(
        "WEB_SESSION_RECOVERY_FAILED",
        `Authoring job creation failed and WCO could not persist the blocked recovery state: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
      );
    }
    throw error;
  }
  session.job_id = identity.job_id;
  session.state = "AUTHORING";
  await save(options.stateDirectory, session);
  return session;
}

export async function appendLocalClarification(options: { bridge: WebBridge; session: LocalWorkerSession; value: string; stateDirectory: string }): Promise<void> {
  if (options.session.sealed || !options.session.job_id) throw new WebBridgeError("WEB_CONTRACT_ALREADY_SEALED", "The current task contract is already sealed.");
  await options.bridge.submitClarification(options.session.job_id, options.value, `clarify-${contentDigest(options.value)}`);
  await save(options.stateDirectory, options.session);
}

export async function completeLocalWorkerSession(options: { session: LocalWorkerSession; stateDirectory: string }): Promise<void> {
  if (!options.session.sealed || !options.session.run_id) throw new WebBridgeError("WEB_SESSION_INVALID", "Only a sealed prepared task can be completed.");
  options.session.state = "COMPLETED";
  await save(options.stateDirectory, options.session);
}

export async function advanceLocalWorker(options: {
  bridge: WebBridge;
  session: LocalWorkerSession;
  repositoryPath: string;
  stateDirectory: string;
  configPath: string;
  config: TrustedConfig;
  maximumEvents?: number;
  stopAfterPrepared?: boolean;
}): Promise<LocalWorkerSession> {
  const session = options.session;
  if (!session.job_id) throw new WebBridgeError("WEB_SESSION_INVALID", "Authoring job identity is missing.");
  const coverage = new ReadCoverageStore(path.join(options.stateDirectory, "bridge", "read-coverage"));
  const reader = new ExactRepositoryReadService(options.repositoryPath, session.repository, coverage, {}, new ContentAddressedContextCache(path.join(options.stateDirectory, "cache", "web-context")));

  for (let count = 0; count < (options.maximumEvents ?? 32); count += 1) {
    const event = await options.bridge.waitForAuthoringEvent(session.job_id, session.last_event_sequence);
    if (!event) break;
    if (event.sequence <= session.last_event_sequence) throw new WebBridgeError("WEB_EVENT_SEQUENCE_INVALID", "Relay event sequence did not advance.");

    if (event.type === "repository_command") {
      const result = await reader.execute(session.job_id, event.request_id, event.command);
      await options.bridge.submitRepositoryCommandResult(session.job_id, { request_id: event.request_id, result }, `repo-result-${event.request_id}`);
      try {
        await persistSemanticShadowObservation({
          stateDirectory: options.stateDirectory,
          sessionId: session.session_id,
          repository: session.repository,
          eventSequence: event.sequence,
          requestId: event.request_id,
          command: event.command,
          result,
        });
      } catch {
        // Shadow evidence is deliberately non-authoritative: observation failure
        // must never suppress an exact repository result already delivered to Web.
      }
    } else if (event.type === "contract_sealed") {
      if (event.envelope.job_id !== session.job_id || event.envelope.user_intent !== session.goal || contentDigest(event.envelope.repository) !== contentDigest(session.repository)) throw new WebBridgeError("WEB_CONTRACT_BINDING_MISMATCH", "Sealed Web contract does not bind the original authoring job, user intent, and exact repository.");
      const materialized = await materializeTaskBundle({ envelope: event.envelope, repository: session.repository, config: options.config, stateDirectory: options.stateDirectory });
      const prepared = await prepareTask({ archivePath: materialized.archive_path, stateDirectory: options.stateDirectory, configPath: options.configPath });
      if (isPreparedRunAwareWebBridge(options.bridge)) {
        await options.bridge.bindPreparedRun(
          session.job_id,
          prepared.run_id,
          `bind-prepared-${contentDigest({ job_id: session.job_id, run_id: prepared.run_id })}`,
        );
      }
      session.sealed = true;
      session.contract = event.envelope;
      session.task_archive_path = materialized.archive_path;
      session.run_id = prepared.run_id;
      session.reviewer_selection = await freezeRunReviewMode(options.stateDirectory, prepared.run_id, session.reviewer_selection ?? DEFAULT_REVIEWER);
      session.state = "PREPARED";
    } else {
      if (!session.contract || !session.run_id) throw new WebBridgeError("WEB_IMPLEMENTATION_OUT_OF_ORDER", "Web implementation arrived before canonical contract preparation.");
      if (event.submission.job_id !== session.job_id || event.submission.run_id !== session.run_id) throw new WebBridgeError("WEB_PACK_BINDING_MISMATCH", "Web implementation identity is stale or bound to another authoring job.");
      const pack = await materializeWebImplementationPack({ submission: event.submission, envelope: session.contract, stateDirectory: options.stateDirectory, configPath: options.configPath, coverageStore: coverage });
      session.web_pack_path = pack.archive_path;
      session.state = "IMPLEMENTATION_REGISTERED";
    }

    session.last_event_sequence = event.sequence;
    await save(options.stateDirectory, session);
    if (event.type === "contract_sealed" && options.stopAfterPrepared) break;
  }
  return session;
}
