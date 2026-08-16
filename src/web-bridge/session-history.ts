import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { resumeRun } from "../orchestration/controller.js";
import { readRunLedger, writeRunLedger } from "../orchestration/ledger.js";
import { withRunLock, withTransitionExecutionLock } from "../orchestration/run-lock.js";
import { atomicWriteJson, readRunReceipt } from "../run/run-store.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { readStableFile } from "../shared/stable-file.js";
import { contentDigest, parseWebContractEnvelope } from "./contracts.js";
import type { LocalWorkerSession } from "./local-worker.js";
import { withSessionFocusLock } from "./session-focus-lock.js";

const HISTORY_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_MAX_FILES = 512;
const HISTORY_SCAN_HARD_LIMIT = 4_096;
const SAFE_HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CURRENT_SESSION_ID = /^[0-9a-f-]{36}$/i;
const HISTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{64}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_STATES = new Set(["CREATING", "AUTHORING", "CONTRACT_SEALED", "PREPARED", "IMPLEMENTATION_REGISTERED", "COMPLETED", "BLOCKED"]);

function validSession(value: unknown): value is LocalWorkerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LocalWorkerSession>;
  if (item.schema_version !== "1.0" || typeof item.session_id !== "string" || !SAFE_HISTORY_ID.test(item.session_id)) return false;
  if (!item.repository || typeof item.repository.repository_id !== "string" || !SAFE_HISTORY_ID.test(item.repository.repository_id) || typeof item.repository.base_branch !== "string" || !item.repository.base_branch || typeof item.repository.base_commit !== "string" || !/^[a-f0-9]{40}$/.test(item.repository.base_commit)) return false;
  if (typeof item.goal !== "string" || !item.goal || item.goal.length > 65_536 || !Number.isSafeInteger(item.last_event_sequence) || (item.last_event_sequence ?? -1) < 0 || typeof item.sealed !== "boolean") return false;
  if (typeof item.state !== "string" || !SESSION_STATES.has(item.state) || typeof item.created_at !== "string" || typeof item.updated_at !== "string" || !Number.isFinite(Date.parse(item.created_at)) || !Number.isFinite(Date.parse(item.updated_at))) return false;
  if (item.job_mode !== undefined && item.job_mode !== "PAIR" && item.job_mode !== "AUTOPILOT") return false;
  if (item.job_id !== null && (typeof item.job_id !== "string" || !JOB_ID.test(item.job_id))) return false;
  for (const field of [item.task_archive_path, item.web_pack_path]) if (field !== null && (typeof field !== "string" || !path.isAbsolute(field))) return false;
  if (item.run_id !== null && (typeof item.run_id !== "string" || !RUN_ID.test(item.run_id))) return false;
  try {
    if (item.contract !== null) {
      const contract = parseWebContractEnvelope(item.contract);
      if (item.job_id === null || contract.job_id !== item.job_id || contract.user_intent !== item.goal || contentDigest(contract.repository) !== contentDigest(item.repository)) return false;
    }
  } catch { return false; }
  if (item.sealed && item.contract === null) return false;
  if (["PREPARED", "IMPLEMENTATION_REGISTERED", "COMPLETED"].includes(item.state) && (!item.sealed || !item.run_id || !item.task_archive_path)) return false;
  if (item.state === "IMPLEMENTATION_REGISTERED" && !item.web_pack_path) return false;
  return true;
}

function historyDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "bridge", "sessions", "history");
}

function currentSessionPath(stateDirectory: string, repositoryId: string): string {
  if (!SAFE_HISTORY_ID.test(repositoryId)) throw new Error("WEB_SESSION_ID_INVALID: repository identity is invalid.");
  return path.join(stateDirectory, "bridge", "sessions", `${repositoryId}.json`);
}

function splitRunId(runId: string): { taskId: string; archiveSha256: string } {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index);
  const archiveSha256 = runId.slice(index + 1);
  if (index <= 0 || !SAFE_HISTORY_ID.test(taskId) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("WEB_HISTORY_NOT_RESUMABLE: run identity is invalid.");
  return { taskId, archiveSha256 };
}

async function assertBoundedStateArtifact(stateDirectory: string, target: string, label: string): Promise<void> {
  if (!path.isAbsolute(target)) throw new Error(`WEB_HISTORY_NOT_RESUMABLE: ${label} is not an absolute WCO artifact path.`);
  const pathInfo = await lstat(target).catch(() => null);
  if (!pathInfo || !pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error(`WEB_HISTORY_NOT_RESUMABLE: ${label} is not a regular non-symlink WCO artifact.`);
  const [root, resolved] = await Promise.all([realpath(path.resolve(stateDirectory)), realpath(target)]);
  if (resolved !== path.resolve(target)) throw new Error(`WEB_HISTORY_NOT_RESUMABLE: ${label} uses a redirected path and cannot be trusted for resume.`);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`WEB_HISTORY_NOT_RESUMABLE: ${label} is outside the WCO state root.`);
}

async function prepareHistoryDirectory(stateDirectory: string): Promise<string> {
  const stateRoot = path.resolve(stateDirectory);
  const [stateInfo, canonical] = await Promise.all([lstat(stateRoot), realpath(stateRoot)]);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || canonical !== stateRoot) throw new Error("WEB_HISTORY_PATH_UNSAFE: state directory is unsafe.");
  return await ensureCanonicalDirectory(historyDirectory(stateRoot), "WCO session history");
}

async function prepareSessionDirectory(stateDirectory: string): Promise<string> {
  const stateRoot = path.resolve(stateDirectory);
  const [stateInfo, canonical] = await Promise.all([lstat(stateRoot), realpath(stateRoot)]);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || canonical !== stateRoot) throw new Error("WEB_HISTORY_PATH_UNSAFE: state directory is unsafe.");
  return await ensureCanonicalDirectory(path.join(stateRoot, "bridge", "sessions"), "WCO session storage");
}

async function readCurrentSessionForConfirmation(target: string, repositoryId: string): Promise<LocalWorkerSession | null> {
  const info = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  const { bytes } = await readStableFile(target, HISTORY_ENTRY_MAX_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("WEB_HISTORY_NOT_RESUMABLE: current task focus is not valid JSON."); }
  if (!validSession(parsed) || parsed.repository.repository_id !== repositoryId) throw new Error("WEB_HISTORY_NOT_RESUMABLE: current task focus is not a valid durable session for this repository.");
  return parsed;
}

async function pruneForInsert(stateDirectory: string): Promise<string> {
  const history = await prepareHistoryDirectory(stateDirectory);
  const names = (await readdir(history)).filter((name) => HISTORY_NAME.test(name));
  if (names.length > HISTORY_SCAN_HARD_LIMIT) throw new Error("WEB_HISTORY_LIMIT: session history exceeds its safe maintenance bound.");
  if (names.length < HISTORY_MAX_FILES) return history;

  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const target = path.join(history, name);
    const info = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      await unlink(target).catch(() => undefined);
      continue;
    }
    entries.push({ name, mtimeMs: info.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const removeCount = Math.max(0, entries.length - HISTORY_MAX_FILES + 1);
  for (const entry of entries.slice(0, removeCount)) await unlink(path.join(history, entry.name)).catch(() => undefined);
  return history;
}

export async function archiveLocalTaskHistory(stateDirectory: string, session: LocalWorkerSession): Promise<void> {
  if (!CURRENT_SESSION_ID.test(session.session_id)) throw new Error("WEB_SESSION_ID_INVALID: session identity is invalid.");
  const serializedBytes = Buffer.byteLength(JSON.stringify(session), "utf8");
  if (serializedBytes > HISTORY_ENTRY_MAX_BYTES) throw new Error("WEB_HISTORY_LIMIT: session history entry exceeds its safe bound.");
  const history = await pruneForInsert(stateDirectory);
  await atomicWriteJson(path.join(history, `${session.session_id}.json`), session);
}

export async function listLocalTaskHistory(stateDirectory: string, repositoryId: string, limit = 10): Promise<LocalWorkerSession[]> {
  if (!SAFE_HISTORY_ID.test(repositoryId)) throw new Error("WEB_SESSION_ID_INVALID: repository identity is invalid.");
  const history = await prepareHistoryDirectory(stateDirectory);
  const names = await readdir(history);
  const candidates = names.filter((name) => HISTORY_NAME.test(name));
  if (candidates.length > HISTORY_SCAN_HARD_LIMIT) throw new Error("WEB_HISTORY_LIMIT: session history exceeds its safe bound.");
  const values: LocalWorkerSession[] = [];
  for (const name of candidates) {
    try {
      const { bytes } = await readStableFile(path.join(history, name), HISTORY_ENTRY_MAX_BYTES);
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (validSession(parsed) && parsed.repository.repository_id === repositoryId && `${parsed.session_id}.json` === name) values.push(parsed);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && error.name === "StableFileError") continue;
      throw error;
    }
  }
  return values.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(Math.max(1, limit), 100));
}

export async function restoreLocalTaskHistoryFocus(
  stateDirectory: string,
  repositoryId: string,
  session: LocalWorkerSession,
  expectedCurrentSessionId?: string | null,
): Promise<LocalWorkerSession> {
  // Never treat history JSON itself as workflow authority. Resume first re-attests
  // the canonical run receipt, run ledger, repository base, and exact bounded
  // artifacts before any current-focus write can occur.
  if (!validSession(session) || !CURRENT_SESSION_ID.test(session.session_id) || session.repository.repository_id !== repositoryId) throw new Error("WEB_HISTORY_NOT_RESUMABLE: history identity does not match a current durable session for this repository.");
  if (session.state !== "IMPLEMENTATION_REGISTERED" || !session.sealed || !session.run_id || !session.task_archive_path || !session.web_pack_path) {
    throw new Error("WEB_HISTORY_NOT_RESUMABLE: this task did not reach a locally re-attestable implementation checkpoint. Start a new follow-up task instead.");
  }
  return await withSessionFocusLock(stateDirectory, repositoryId, async () => {
    const sessionDirectory = await prepareSessionDirectory(stateDirectory);
    const target = currentSessionPath(stateDirectory, repositoryId);
    if (path.dirname(target) !== sessionDirectory) throw new Error("WEB_HISTORY_PATH_UNSAFE: restored session path escaped managed session storage.");
    const current = await readCurrentSessionForConfirmation(target, repositoryId);
    if (expectedCurrentSessionId !== undefined && (current?.session_id ?? null) !== expectedCurrentSessionId) {
      throw new Error("WEB_SESSION_STALE: current task focus changed after confirmation in another process. Nothing was switched; inspect /status and retry /resume.");
    }

    const runId = session.run_id!;
    const identity = splitRunId(runId);
    const [ledger, run] = await Promise.all([
      readRunLedger(stateDirectory, runId),
      readRunReceipt(stateDirectory, identity.taskId, identity.archiveSha256),
    ]);
    if (!ledger || ledger.run_id !== runId) throw new Error("WEB_HISTORY_NOT_RESUMABLE: the durable run ledger is missing or no longer matches this task.");
    if (
      !run ||
      run.run_id !== runId ||
      run.task_id !== identity.taskId ||
      run.archive_sha256 !== identity.archiveSha256 ||
      run.repository_id !== repositoryId ||
      run.base_branch !== session.repository.base_branch ||
      run.base_commit !== session.repository.base_commit
    ) {
      throw new Error("WEB_HISTORY_NOT_RESUMABLE: canonical run receipt authority no longer matches the historical task identity or repository base.");
    }
    await Promise.all([
      assertBoundedStateArtifact(stateDirectory, session.task_archive_path!, "task bundle"),
      assertBoundedStateArtifact(stateDirectory, session.web_pack_path!, "implementation pack"),
    ]);

    if (current && current.session_id !== session.session_id) await archiveLocalTaskHistory(stateDirectory, current);
    const restored: LocalWorkerSession = { ...session, updated_at: new Date().toISOString() };

    // Switching focus and clearing a PAIR pause are one logical resume transition.
    // Hold the same execution lock used by normal transitions so no worker can
    // start while focus is being switched. If the focus write fails after a pause
    // was cleared, restore the exact pre-resume ledger before surfacing failure.
    const expectedLedgerSha = contentDigest(ledger);
    return await withTransitionExecutionLock(stateDirectory, runId, async () => {
      const lockedLedger = await readRunLedger(stateDirectory, runId);
      if (!lockedLedger || contentDigest(lockedLedger) !== expectedLedgerSha) {
        throw new Error("WEB_HISTORY_NOT_RESUMABLE: durable run state changed while history resume was being prepared.");
      }

      const isPair = (session.job_mode ?? "PAIR") === "PAIR";
      const resumedLedger = isPair && lockedLedger.paused
        ? await resumeRun(stateDirectory, runId)
        : lockedLedger;
      const resumedLedgerSha = contentDigest(resumedLedger);

      try {
        await atomicWriteJson(target, restored);
        return restored;
      } catch (writeError) {
        if (isPair && lockedLedger.paused) {
          try {
            await withRunLock(stateDirectory, runId, async () => {
              const currentLedger = await readRunLedger(stateDirectory, runId);
              if (!currentLedger || contentDigest(currentLedger) !== resumedLedgerSha) {
                throw new Error("durable run changed after pause clearance");
              }
              await writeRunLedger(stateDirectory, lockedLedger);
            });
          } catch (rollbackError) {
            throw new Error(
              `WEB_HISTORY_FOCUS_RECOVERY_REQUIRED: current focus was not committed and exact PAIR pause rollback could not be proven: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              { cause: writeError },
            );
          }
        }
        throw writeError;
      }
    });
  });
}
