import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import yauzl from "yauzl";
import { WebAuthorityError, type WebImplementationPackManifest } from "./contracts.js";

const MAX_MANIFEST_BYTES = 1_048_576;

interface Inspection {
  archiveSha256: string;
  archiveSizeBytes: number;
  manifestBytes: Buffer;
  manifest: WebImplementationPackManifest;
}

async function assertStablePath(filePath: string, before: Stats, handle: fs.FileHandle): Promise<void> {
  const fdAfter = await handle.stat();
  const pathAfter = await fs.lstat(filePath).catch((error) => {
    throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Registered archive disappeared during inspection: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || fdAfter.dev !== before.dev || fdAfter.ino !== before.ino || fdAfter.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
    throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive changed during inspection.");
  }
}

async function readManifestFromFd(fd: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    yauzl.fromFd(fd, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError || !zip) {
        reject(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Cannot open registered archive: ${openError?.message ?? "unknown error"}`));
        return;
      }
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof WebAuthorityError ? error : new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", error instanceof Error ? error.message : String(error)));
      };
      zip.once("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;
        if (entry.fileName !== "implementation-pack.json") {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_MANIFEST_BYTES || entry.fileName.endsWith("/")) {
          fail(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered implementation manifest is unsafe or oversized."));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Cannot read registered implementation manifest."));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_MANIFEST_BYTES) {
              stream.destroy(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered implementation manifest exceeded the bounded stream limit."));
              return;
            }
            chunks.push(chunk);
          });
          stream.once("error", fail);
          stream.once("end", () => {
            if (settled) return;
            if (total !== entry.uncompressedSize) {
              fail(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered implementation manifest changed size while reading."));
              return;
            }
            settled = true;
            resolve(Buffer.concat(chunks, total));
          });
        });
      });
      zip.once("end", () => {
        if (!settled) fail(new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive is missing implementation-pack.json."));
      });
      zip.readEntry();
    });
  });
}

export async function inspectRegisteredArchive(filePath: string): Promise<Inspection> {
  const pathBefore = await fs.lstat(filePath).catch((error) => {
    throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Cannot inspect registered archive: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive must be a regular non-symlink file.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Cannot safely open registered archive: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive changed before inspection.");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (bytesRead === 0) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive was truncated while hashing.");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered archive grew while hashing.");
    const manifestBytes = await readManifestFromFd(handle.fd);
    await assertStablePath(filePath, before, handle);
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered implementation manifest is not valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered implementation manifest must be a JSON object.");
    return {
      archiveSha256: hash.digest("hex"),
      archiveSizeBytes: before.size,
      manifestBytes,
      manifest: parsed as WebImplementationPackManifest,
    };
  } finally {
    await handle.close();
  }
}
