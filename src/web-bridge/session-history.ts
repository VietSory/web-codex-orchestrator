import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { LocalWorkerSession } from "./local-worker.js";

function validSession(value: unknown): value is LocalWorkerSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalWorkerSession>;
  return item.schema_version === "1.0" && typeof item.session_id === "string" && typeof item.goal === "string" && typeof item.updated_at === "string" && Boolean(item.repository && typeof item.repository.repository_id === "string");
}

export async function listLocalTaskHistory(stateDirectory: string, repositoryId: string, limit = 10): Promise<LocalWorkerSession[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repositoryId)) throw new Error("WEB_SESSION_ID_INVALID: repository identity is invalid.");
  const history = path.join(stateDirectory, "bridge", "sessions", "history");
  let names: string[];
  try { names = await readdir(history); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (names.length > 4096) throw new Error("WEB_HISTORY_LIMIT: session history exceeds its safe bound.");
  const values: LocalWorkerSession[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9-]{1,128}\.json$/.test(name)) continue;
    const bytes = await readFile(path.join(history, name));
    if (bytes.byteLength > 1_048_576) throw new Error("WEB_HISTORY_LIMIT: session history entry exceeds its safe bound.");
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (validSession(parsed) && parsed.repository.repository_id === repositoryId) values.push(parsed);
  }
  return values.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.min(Math.max(1, limit), 100));
}
