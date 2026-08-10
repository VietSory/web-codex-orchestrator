import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError } from "./contracts.js";
import { prepareOrchestrationDirectory } from "./ledger.js";
import { orchestrationPaths } from "./paths.js";

export type WcoMode = "PAIR" | "AUTOPILOT";

export interface WcoJobContract {
  job_version: "1.0";
  run_id: string;
  mode: WcoMode;
  goal: string;
  repository: {
    id: string;
    base_branch: string;
    base_commit: string;
  };
  human_gate_policy: {
    merge: true;
    mark_ready: true;
    deployment: true;
    destructive_git: true;
  };
  created_at: string;
  updated_at: string;
}

const MAX_JOB_BYTES = 64 * 1024;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function invalid(code: string, message: string): never {
  throw new OrchestrationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(taskBundleSha256)) {
    invalid("ORCHESTRATION_RUN_ID_INVALID", "run_id must be <safe-task-id>:<task-bundle-sha256>.");
  }
  return { taskId, taskBundleSha256 };
}

function validateJob(value: unknown): WcoJobContract {
  if (!isRecord(value)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract must be an object.");
  const allowed = new Set(["job_version", "run_id", "mode", "goal", "repository", "human_gate_policy", "created_at", "updated_at"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid("ORCHESTRATION_JOB_INVALID", `WCO job contract contains unknown field '${key}'.`);
  if (value.job_version !== "1.0") invalid("ORCHESTRATION_JOB_INVALID", "Unsupported WCO job contract version.");
  if (typeof value.run_id !== "string") invalid("ORCHESTRATION_JOB_INVALID", "WCO job run_id is invalid.");
  splitRunId(value.run_id);
  if (value.mode !== "PAIR" && value.mode !== "AUTOPILOT") invalid("ORCHESTRATION_JOB_INVALID", "WCO job mode must be PAIR or AUTOPILOT.");
  if (typeof value.goal !== "string" || value.goal.trim().length < 1 || value.goal.length > 16_384 || value.goal.includes("\0")) invalid("ORCHESTRATION_JOB_INVALID", "WCO job goal is invalid.");
  if (!isRecord(value.repository)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job repository binding is invalid.");
  const repositoryKeys = Object.keys(value.repository);
  if (repositoryKeys.length !== 3 || !repositoryKeys.every((key) => ["id", "base_branch", "base_commit"].includes(key))) invalid("ORCHESTRATION_JOB_INVALID", "WCO job repository binding has an invalid shape.");
  if (typeof value.repository.id !== "string" || !SAFE_REPOSITORY_ID.test(value.repository.id)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job repository id is invalid.");
  if (typeof value.repository.base_branch !== "string" || value.repository.base_branch.length < 1 || value.repository.base_branch.length > 256 || value.repository.base_branch.includes("\0")) invalid("ORCHESTRATION_JOB_INVALID", "WCO job base branch is invalid.");
  if (typeof value.repository.base_commit !== "string" || !GIT_OBJECT_ID.test(value.repository.base_commit)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job base commit is invalid.");
  if (!isRecord(value.human_gate_policy)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job human gate policy is invalid.");
  const gateKeys = ["merge", "mark_ready", "deployment", "destructive_git"] as const;
  if (Object.keys(value.human_gate_policy).length !== gateKeys.length || !gateKeys.every((key) => value.human_gate_policy[key] === true)) invalid("ORCHESTRATION_JOB_INVALID", "Human-owned gates cannot be disabled by a WCO job.");
  if (typeof value.created_at !== "string" || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at)) || Date.parse(value.updated_at) < Date.parse(value.created_at)) invalid("ORCHESTRATION_JOB_INVALID", "WCO job timestamps are invalid.");
  return value as unknown as WcoJobContract;
}

function jobPath(stateDirectory: string, runId: string): { directory: string; file: string } {
  const { taskId, taskBundleSha256 } = splitRunId(runId);
  const paths = orchestrationPaths(stateDirectory, taskId, taskBundleSha256);
  return { directory: paths.directory, file: path.join(paths.directory, "job.json") };
}

export function createWcoJobContract(options: {
  runId: string;
  mode: WcoMode;
  goal: string;
  repository: WcoJobContract["repository"];
  now?: Date;
}): WcoJobContract {
  const now = (options.now ?? new Date()).toISOString();
  return validateJob({
    job_version: "1.0",
    run_id: options.runId,
    mode: options.mode,
    goal: options.goal.trim(),
    repository: options.repository,
    human_gate_policy: { merge: true, mark_ready: true, deployment: true, destructive_git: true },
    created_at: now,
    updated_at: now,
  });
}

export function wcoJobDigest(job: WcoJobContract): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer(validateJob(job))).digest("hex");
}

export async function readWcoJobContract(stateDirectory: string, runId: string): Promise<WcoJobContract | null> {
  const target = jobPath(stateDirectory, runId);
  let stat;
  try { stat = await fs.lstat(target.file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > MAX_JOB_BYTES) invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract must be a bounded regular non-symlink file.");
  const bytes = await fs.readFile(target.file);
  if (bytes.length !== stat.size || bytes.length > MAX_JOB_BYTES) invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract changed while reading.");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract is not valid JSON."); }
  const job = validateJob(parsed);
  if (job.run_id !== runId) invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract run identity does not match its state path.");
  return job;
}

export async function registerWcoJobContract(options: { stateDirectory: string; job: WcoJobContract }): Promise<{ job: WcoJobContract; sha256: string; created: boolean }> {
  const job = validateJob(options.job);
  const target = jobPath(options.stateDirectory, job.run_id);
  const existing = await readWcoJobContract(options.stateDirectory, job.run_id);
  if (existing) {
    const existingDigest = wcoJobDigest(existing);
    const requestedDigest = wcoJobDigest(job);
    if (existingDigest !== requestedDigest) invalid("ORCHESTRATION_JOB_CONFLICT", "A different immutable WCO job contract is already registered for this run.");
    return { job: existing, sha256: existingDigest, created: false };
  }

  await prepareOrchestrationDirectory(options.stateDirectory, target.directory);
  const bytes = Buffer.concat([canonicalJsonBuffer(job), Buffer.from("\n")]);
  if (bytes.length > MAX_JOB_BYTES) invalid("ORCHESTRATION_JOB_INVALID", "WCO job contract exceeds the bounded state size.");
  const temporary = path.join(target.directory, `.job.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target.file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readWcoJobContract(options.stateDirectory, job.run_id);
      if (raced && wcoJobDigest(raced) === wcoJobDigest(job)) return { job: raced, sha256: wcoJobDigest(raced), created: false };
    }
    throw error;
  }
  return { job, sha256: wcoJobDigest(job), created: true };
}
