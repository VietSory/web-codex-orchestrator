import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import yauzl from "yauzl";
import yazl from "yazl";
import { canonicalJsonBuffer } from "../../src/result-bundle/canonical-json.js";

const sha256 = (value: Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const BINDINGS: Record<string, string> = {
  "repository-inventory.json": "repository_inventory_sha256",
  "read-coverage.json": "read_coverage_sha256",
  "project-map.json": "project_map_sha256",
  "source-receipts.json": "source_receipts_sha256",
  "preimages.json": "preimages_sha256",
  "architecture-lock.json": "architecture_lock_sha256",
  "acceptance-lock.json": "acceptance_lock_sha256",
  "prohibited-changes.json": "prohibited_changes_sha256",
  "operations.json": "operations_sha256",
};

async function readZipEntries(archivePath: string): Promise<Map<string, Buffer>> {
  return await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error("cannot open zip")); return; }
      const entries = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { reject(streamError ?? new Error("cannot read zip entry")); return; }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.once("error", reject);
      zip.once("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

async function writeZip(entries: ReadonlyMap<string, Buffer>, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, bytes] of [...entries.entries()].sort(([a], [b]) => lexical(a, b))) zip.addBuffer(bytes, name, { compress: false });
    const output = fsSync.createWriteStream(destination, { flags: "wx" });
    zip.outputStream.once("error", reject);
    output.once("error", reject);
    output.once("close", resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

export async function rewriteWebPackJson(options: {
  archivePath: string;
  entryPath: string;
  mutate: (value: Record<string, unknown>) => Record<string, unknown>;
  destination?: string;
}): Promise<string> {
  const entries = await readZipEntries(options.archivePath);
  const source = entries.get(options.entryPath);
  if (!source) throw new Error(`Missing entry ${options.entryPath}`);
  const parsed = JSON.parse(source.toString("utf8")) as Record<string, unknown>;
  entries.set(options.entryPath, canonicalJsonBuffer(options.mutate(parsed)));

  const bindingKey = BINDINGS[options.entryPath];
  if (bindingKey) {
    const manifestBytes = entries.get("implementation-pack.json");
    if (!manifestBytes) throw new Error("Missing implementation-pack.json");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    const bindings = { ...(manifest.bindings as Record<string, unknown>) };
    bindings[bindingKey] = sha256(entries.get(options.entryPath)!);
    entries.set("implementation-pack.json", canonicalJsonBuffer({ ...manifest, bindings }));
  }

  entries.delete("checksums.json");
  const checksumEntries = [...entries.entries()].sort(([a], [b]) => lexical(a, b)).map(([entryPath, bytes]) => ({ path: entryPath, sha256: sha256(bytes), size_bytes: bytes.byteLength }));
  entries.set("checksums.json", canonicalJsonBuffer({ schema_version: "2.0", algorithm: "sha256", entries: checksumEntries }));
  const destination = options.destination ?? path.join(path.dirname(options.archivePath), `mutated-${crypto.randomUUID()}.zip`);
  await writeZip(entries, destination);
  return destination;
}

export async function removeWebPackMutationArtifacts(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}
