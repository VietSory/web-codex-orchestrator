import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { WebAuthorityError } from "./contracts.js";

export type AuthorityReadErrorCode = "WEB_AUTHORITY_BINDING_MISMATCH" | "WEB_AUTHORITY_PREIMAGE_INVALID";

function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(data: Buffer): string { return crypto.createHash("sha256").update(data).digest("hex"); }

export async function readBoundedStableAuthorityFile(filePath: string, maximumBytes: number, code: AuthorityReadErrorCode, label: string): Promise<Buffer> {
  const before = await fs.lstat(filePath).catch((error) => {
    throw new WebAuthorityError(code, `Cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (before.isSymbolicLink() || !before.isFile()) throw new WebAuthorityError(code, `${label} must be a regular non-symlink file.`);
  if (before.size > maximumBytes) throw new WebAuthorityError(code, `${label} exceeds ${maximumBytes} bytes.`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new WebAuthorityError(code, `Cannot safely open ${label}: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > maximumBytes) throw new WebAuthorityError(code, `${label} changed before bounded read.`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new WebAuthorityError(code, `${label} was truncated during bounded read.`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebAuthorityError(code, `${label} grew during bounded read.`);
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    if (afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size) throw new WebAuthorityError(code, `${label} changed during bounded read.`);
    return bytes;
  } finally { await handle.close(); }
}

export async function computeAcceptedTaskSpecSetSha256(bundlePath: string, taskId: string, runId: string, archiveSha256: string): Promise<string> {
  const names = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json"];
  const files: Array<{ name: string; buffer: Buffer }> = [];
  for (const name of names) files.push({ name, buffer: await readBoundedStableAuthorityFile(path.join(bundlePath, name), 8_388_608, "WEB_AUTHORITY_BINDING_MISMATCH", `accepted task file '${name}'`) });
  files.push({ name: "README.md", buffer: Buffer.from([
    "# Task Specification Overview", "", `Task ID: \`${taskId}\``, `Run ID: \`${runId}\``, `Archive SHA-256: \`${archiveSha256}\``, "",
    "This directory contains the task specification and spec-lock.",
    "Files copied from the accepted task bundle are preserved verbatim.",
    "The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",
  ].join("\n") + "\n", "utf8") });
  const authoritative = files.sort((a, b) => lexical(a.name, b.name)).map((entry) => ({ path: `task/${entry.name}`, sha256: sha256(entry.buffer), size_bytes: entry.buffer.byteLength }));
  return sha256(canonicalJsonBuffer(authoritative));
}
