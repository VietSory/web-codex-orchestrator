import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { RunEvent, RunState } from "./contracts.js";

const JOURNAL_SCAN_CHUNK_BYTES = 64 * 1024;

function eventsPath(stateDirectory: string, taskId: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "events.jsonl");
}

async function nextSequence(filePath: string, runId: string): Promise<number> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Event journal must be a regular non-symlink file.");
  if (info.size === 0) return 1;

  const handle = await open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw new Error("Event journal changed before sequence recovery.");
    }

    let position = opened.size;
    let suffix = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(JOURNAL_SCAN_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new Error("Event journal changed during sequence recovery.");
      suffix = Buffer.concat([chunk, suffix], chunk.byteLength + suffix.byteLength);

      let end = suffix.length;
      while (end > 0 && (suffix[end - 1] === 0x0a || suffix[end - 1] === 0x0d)) end -= 1;
      const newline = suffix.lastIndexOf(0x0a, end - 1);
      if (newline >= 0 || position === 0) {
        const start = newline >= 0 ? newline + 1 : 0;
        const line = suffix.subarray(start, end).toString("utf8");
        if (line.length === 0) return 1;
        let previous: unknown;
        try {
          previous = JSON.parse(line) as unknown;
        } catch {
          throw new Error("Event journal has an invalid final record.");
        }
        if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("Event journal final record is invalid.");
        const record = previous as Record<string, unknown>;
        if (record.run_id !== runId || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1) {
          throw new Error("Event journal final record identity or sequence is invalid.");
        }
        const after = await handle.stat();
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new Error("Event journal changed during sequence recovery.");
        }
        return Number(record.sequence) + 1;
      }
    }
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
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
  const sequence = await nextSequence(filePath, runId);
  const event: RunEvent = { event_version: "1.0", run_id: runId, sequence, from, to, timestamp: now().toISOString(), details };
  const line = `${JSON.stringify(event)}\n`;
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}
