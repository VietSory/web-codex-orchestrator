import { constants as fsConstants, type Stats } from "node:fs";
import { appendFile, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { RunEvent, RunState } from "./contracts.js";

const MAX_EVENT_JOURNAL_BYTES = 1024 * 1024;
const MAX_DETAILS_KEYS = 64;
const MAX_DETAIL_STRING = 8192;

function eventsPath(stateDirectory: string, taskId: string, archiveSha256: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("Run event journal identity is unsafe.");
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256, "events.jsonl");
}

function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizeDetail(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, MAX_DETAILS_KEYS).map(([key, item]) => [key.slice(0, 128), sanitizeDetail(item, depth + 1)]));
  }
  if (typeof value === "string") return value.slice(0, MAX_DETAIL_STRING);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || typeof value === "boolean") return value;
  return undefined;
}

async function readStableJournal(filePath: string): Promise<Buffer> {
  let pathBefore: Stats;
  try { pathBefore = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_EVENT_JOURNAL_BYTES) throw new Error("Event journal must be a bounded regular non-symlink file.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_EVENT_JOURNAL_BYTES) throw new Error("Event journal changed before open.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Event journal was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error("Event journal grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) throw new Error("Event journal changed while reading.");
    return bytes;
  } finally {
    await handle.close();
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
  const content = await readStableJournal(filePath);
  const sequence = content.toString("utf8").split(/\r?\n/).filter(Boolean).length + 1;
  const event: RunEvent = {
    event_version: "1.0",
    run_id: runId.slice(0, 512),
    sequence,
    from,
    to,
    timestamp: now().toISOString(),
    details: sanitizeDetail(details) as Record<string, unknown>,
  };
  const line = `${JSON.stringify(event)}\n`;
  const nextBytes = content.byteLength + Buffer.byteLength(line, "utf8");
  if (nextBytes > MAX_EVENT_JOURNAL_BYTES) throw new Error(`Event journal exceeds ${MAX_EVENT_JOURNAL_BYTES} bytes.`);
  await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  const after = await lstat(filePath);
  if (after.isSymbolicLink() || !after.isFile() || after.size > MAX_EVENT_JOURNAL_BYTES) throw new Error("Event journal exceeded its byte cap during append.");
  return event;
}
