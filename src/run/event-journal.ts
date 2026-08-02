import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvent, RunState } from "./contracts.js";

function eventsPath(stateDirectory: string, taskId: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "events.jsonl");
}

export async function appendRunEvent(
  stateDirectory: string,
  taskId: string,
  archiveSha256: string,
  runId: string,
  from: RunState,
  to: RunState,
  details: Record<string, unknown> = {},
  now = () => new Date(),
): Promise<RunEvent> {
  const filePath = eventsPath(stateDirectory, taskId, archiveSha256);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Event journal must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let sequence = 1;
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    sequence = lines.length + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const event: RunEvent = { event_version: "1.0", run_id: runId, sequence, from, to, timestamp: now().toISOString(), details };
  await appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}
