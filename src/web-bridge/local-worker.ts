import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REVIEWER, type ReviewerSelection } from "../agent/reviewer-selection.js";
import { freezeRunReviewMode } from "../agent/reviewer-mode-store.js";
import type { TrustedConfig } from "../config/contracts.js";
import type { JobMode } from "../orchestration/job-mode.js";
import { atomicWriteJson } from "../run/run-store.js";
import { prepareTask } from "../run/preparation-service.js";
import { contentDigest, WebBridgeError, type RepositoryBinding, type WebContractEnvelope } from "./contracts.js";
import type { WebBridge } from "./web-bridge.js";
import { ExactRepositoryReadService } from "./repo-read-service.js";
import { ReadCoverageStore } from "./read-coverage-store.js";
import { materializeTaskBundle } from "./task-contract-materializer.js";
import { materializeWebImplementationPack } from "./web-pack-materializer.js";

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

export function localWorkerJobMode(session: Pick<LocalWorkerSession, "job_mode">): JobMode {
  return session.job_mode ?? "PAIR";
}

export async function readLocalWorkerSession(stateDirectory: string, repositoryId: string): Promise<LocalWorkerSession | null> {
  try { return JSON.parse(await readFile(sessionPath(stateDirectory, repositoryId), "utf8")) as LocalWorkerSession; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function save(stateDirectory: string, value: LocalWorkerSession): Promise<void> {
  await mkdir(path.dirname(sessionPath(stateDirectory, value.repository.repository_id)), { recursive: true, mode: 0o700 });
  value.updated_at = new Date().toISOString();
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
  if (existing) {
    const historyPath = path.join(options.stateDirectory, "bridge", "sessions", "history", `${existing.session_id}.json`);
    await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await atomicWriteJson(historyPath, existing);
  }

  const now = options.now?.() ?? new Date();
  const mode = options.mode ?? "PAIR";
  const reviewerSelection = options.reviewerSelection ?? { ...DEFAULT_REVIEWER };
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

  const identity = await options.bridge.createAuthoringJob({
    owner: options.owner ?? "local",
    repository: options.repository,
    user_intent: options.goal,
    ttl_seconds: 86_400,
    orchestration_mode: mode,
  }, `author-${session.session_id}`);
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
  const reader = new ExactRepositoryReadService(options.repositoryPath, session.repository, coverage);

  for (let count = 0; count < (options.maximumEvents ?? 32); count += 1) {
    const event = await options.bridge.waitForAuthoringEvent(session.job_id, session.last_event_sequence);
    if (!event) break;
    if (event.sequence <= session.last_event_sequence) throw new WebBridgeError("WEB_EVENT_SEQUENCE_INVALID", "Relay event sequence did not advance.");

    if (event.type === "repository_command") {
      const result = await reader.execute(session.job_id, event.request_id, event.command);
      await options.bridge.submitRepositoryCommandResult(session.job_id, { request_id: event.request_id, result }, `repo-result-${event.request_id}`);
    } else if (event.type === "contract_sealed") {
      const materialized = await materializeTaskBundle({ envelope: event.envelope, repository: session.repository, config: options.config, stateDirectory: options.stateDirectory });
      const prepared = await prepareTask({ archivePath: materialized.archive_path, stateDirectory: options.stateDirectory, configPath: options.configPath });
      session.sealed = true;
      session.contract = event.envelope;
      session.task_archive_path = materialized.archive_path;
      session.run_id = prepared.run_id;
      session.reviewer_selection = await freezeRunReviewMode(options.stateDirectory, prepared.run_id, session.reviewer_selection ?? DEFAULT_REVIEWER);
      session.state = "PREPARED";
    } else {
      if (!session.contract || !session.run_id) throw new WebBridgeError("WEB_IMPLEMENTATION_OUT_OF_ORDER", "Web implementation arrived before canonical contract preparation.");
      if (event.submission.run_id !== session.run_id) throw new WebBridgeError("WEB_PACK_BINDING_MISMATCH", "Web implementation run identity is stale.");
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
