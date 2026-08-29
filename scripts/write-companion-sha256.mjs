#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;

/** GNU sha256sum-compatible, portable release sidecar: ASCII, two spaces,
 * exact basename, and one LF. Never use platform text newline conversion. */
export function canonicalSha256Sidecar(digest, filename) {
  if (!SHA256.test(digest)) throw new Error("Companion SHA-256 must be 64 lowercase hexadecimal characters.");
  if (!filename || filename !== path.basename(filename) || /[\r\n\0]/u.test(filename)) throw new Error("Companion sidecar filename must be one safe basename.");
  return Buffer.from(`${digest}  ${filename}\n`, "ascii");
}

export async function writeCompanionSha256(executablePath, sidecarPath, filename = path.basename(executablePath)) {
  const digest = createHash("sha256").update(await readFile(executablePath)).digest("hex");
  await writeFile(sidecarPath, canonicalSha256Sidecar(digest, filename), { mode: 0o644 });
  return digest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [executablePath, sidecarPath, filename] = process.argv.slice(2);
  if (!executablePath || !sidecarPath || !filename) throw new Error("Usage: write-companion-sha256.mjs <executable> <sidecar> <filename>");
  const digest = await writeCompanionSha256(executablePath, sidecarPath, filename);
  process.stdout.write(`${digest}\n`);
}
