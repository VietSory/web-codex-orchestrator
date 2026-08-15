import { lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { readRunLedger } from "../orchestration/ledger.js";
import { atomicWriteJson } from "../run/run-store.js";
import { readStableFile } from "../shared/stable-file.js";
import type { LocalWorkerSession } from "./local-worker.js";

const HISTORY_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_MAX_FILES = 512;
const HISTORY_SCAN_HARD_LIMIT = 4_096;
const SAFE_HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CURRENT_SESSION_ID = /^[0-9a-f-]{36}$/i;
const HISTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

function validSession(value: unknown): value is LocalWorkerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<LocalWorkerSession>;
  return item.schema_version === "1.0" && typeof item.session_id === "string" && SAFE_HISTORY_ID.test(item.session_id) && typeof item.goal === "string" && typeof item.updated_at === "string" && Number.isFinite(Date.parse(item.updated_at)) && Boolean(item.repository && typeof item.repository.repository_id === "string");
}

function historyDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "bridge", "sessions", "history");
}

function currentSessionPath(stateDirectory: string, repositoryId: string): string {
  if (!SAFE_HISTORY_ID.test(repositoryId)) throw new Error("WEB_SESSION_ID_INVALID: repository identity is invalid.");
  return path.join(stateDirectory, "bridge", "sessions", `${repositoryId}.json`);
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

async function pruneForInsert(history: string): Promise<void> {
  await mkdir(history, { recursive: true, mode: 0o700 });
  const names = (await readdir(history)).filter((name) => HISTORY_NAME.test(name));
  if (names.length > HISTORY_SCAN_HARD_LIMIT) throw new Error("WEB_HISTORY_LIMIT: session history exceeds its safe maintenance bound.");
  if (names.length < HISTORY_MAX_FILES) return;

  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const target = path.join(history, name);
    const info = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    // History is convenience state, not authority. Invalid history entries may
    // be discarded rather than allowed to pin retention capacity.
    if (!info.isFile() || info.isSymbolicLink()) {
      await unlink(target).catch(() => undefined);
      continue;
    }
    entries.push({ name, mtimeMs: info.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const removeCount = Math.max(0, entries.length - HISTORY_MAX_FILES + 1);
  for (const entry of entries.slice(0, removeCount)) await unlink(path.join(history, entry.name)).catch(() => undefined);
}

export async function archiveLocalTaskHistory(stateDirectory: string, session: LocalWorkerSession): Promise<void> {
  // New sessions are always UUIDs. The reader remains compatible with safe
  // legacy IDs because history is non-authoritative convenience state.
  if (!CURRENT_SESSION_ID.test(session.session_id)) throw new Error("WEB_SESSION_ID_INVALID: session identity is invalid.");
  const serializedBytes = Buffer.byteLength(JSON.stringify(session), "utf8");
  if (serializedBytes > HISTORY_ENTRY_MAX_BYTES) throw new Error("WEB_HISTORY_LIMIT: session history entry exceeds its safe bound.");
  const history = historyDirectory(stateDirectory);
  await pruneForInsert(history);
  await atomicWriteJson(path.join(history, `${session.session_id}.json`), session);
}

export async function listLocalTaskHistory(stateDirectory: string, repositoryId: string, limit = 10): Promise<LocalWorkerSession[]> {
  if (!SAFE_HISTORY_ID.test(repositoryId)) throw new Error("WEB_SESSION_ID_INVALID: repository identity is invalid.");
  const history = historyDirectory(stateDirectory);
  let names: string[];
  try { names = await readdir(history); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const candidates = names.filter((name) => HISTORY_NAME.test(name));
  if (candidates.length > HISTORY_SCAN_HARD_LIMIT) throw new Error("WEB_HISTORY_LIMIT: session history exceeds its safe bound.");
  const values: LocalWorkerSession[] = [];
  for (const name of candidates) {
    try {
      const { bytes } = await readStableFile(path.join(history, name), HISTORY_ENTRY_MAX_BYTES);
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (validSession(parsed) && parsed.repository.repository_id === repositoryId && `${parsed.session_id}.json` === name) values.push(parsed);
    } catch (error) {
      // History cannot advance workflow authority. A stale/corrupt convenience
      // record is ignored rather than making the active task unusable.
      if (error instanceof SyntaxError || error instanceof Error && error.name === "StableFileError") continue;
      throw error;
    }
  }
  return values.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(Math.max(1, limit), 100));
}

/**
 * Move an already-durable historical task back into current focus without ever
 * treating the history JSON itself as workflow authority. The selected history
 * item is accepted only when its exact run ledger and implementation artifacts
 * can be re-attested under the current WCO state root. Earlier authoring-only
 * history intentionally remains inspectable but not resumable because its
 * external authoring job cannot be proven from local durable authority alone.
 */
export async function restoreLocalTaskHistoryFocus(
  stateDirectory: string,
  repositoryId: string,
  session: LocalWorkerSession,
): Promise<LocalWorkerSession> {
  if (!validSession(session) || session.repository.repository_id !== repositoryId) throw new Error("WEB_HISTORY_NOT_RESUMABLE: history identity does not match this repository.");
  if (session.state !== "IMPLEMENTATION_REGISTERED" || !session.sealed || !session.run_id || !session.task_archive_path || !session.web_pack_path) {
    throw new Error("WEB_HISTORY_NOT_RESUMABLE: this task did not reach a locally re-attestable implementation checkpoint. Start a new follow-up task instead.");
  }
  const ledger = await readRunLedger(stateDirectory, session.run_id);
  if (!ledger || ledger.run_id !== session.run_id) throw new Error("WEB_HISTORY_NOT_RESUMABLE: the durable run ledger is missing or no longer matches this task.");
  await Promise.all([
    assertBoundedStateArtifact(stateDirectory, session.task_archive_path, "task bundle"),
    assertBoundedStateArtifact(stateDirectory, session.web_pack_path, "implementation pack"),
  ]);

  const restored: LocalWorkerSession = { ...session, updated_at: new Date().toISOString() };
  const target = currentSessionPath(stateDirectory, repositoryId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await atomicWriteJson(target, restored);
  return restored;
}
