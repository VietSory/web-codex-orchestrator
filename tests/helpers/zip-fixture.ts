import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
import yazl from "yazl";

export const templateDirectory = path.resolve("templates/task-bundle");

async function filesUnder(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(current)) {
    const absolute = path.join(current, name);
    const info = await stat(absolute);
    if (info.isDirectory()) files.push(...(await filesUnder(root, absolute)));
    else files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

export async function updateChecksums(bundleDirectory: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const relative of await filesUnder(bundleDirectory)) {
    if (relative === "checksums.json") continue;
    files[relative] = createHash("sha256").update(await readFile(path.join(bundleDirectory, relative))).digest("hex");
  }
  await writeFile(
    path.join(bundleDirectory, "checksums.json"),
    `${JSON.stringify({ algorithm: "sha256", files }, null, 2)}\n`,
  );
}

export async function copyTemplate(root: string): Promise<string> {
  const bundle = path.join(root, "bundle");
  await cp(templateDirectory, bundle, { recursive: true });
  return bundle;
}

export async function writeYazlZip(
  bundleDirectory: string,
  archivePath: string,
  wrapper?: string,
): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
  const done = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    zip.outputStream.once("error", reject);
  });
  zip.outputStream.pipe(output);
  for (const relative of await filesUnder(bundleDirectory)) {
    const metadata = wrapper ? `${wrapper}/${relative}` : relative;
    zip.addFile(path.join(bundleDirectory, relative), metadata);
  }
  zip.end();
  await done;
}

export interface RawZipEntry {
  name: string;
  data?: Buffer;
  compressedData?: Buffer;
  uncompressedSize?: number;
  compressionMethod?: number;
  flags?: number;
  externalFileAttributes?: number;
  versionMadeBy?: number;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value & 0xffff);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0);
  return result;
}

/** Minimal deterministic ZIP writer for hostile-entry tests. */
export async function writeRawZip(archivePath: string, entries: RawZipEntry[]): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const plain = item.data ?? Buffer.alloc(0);
    const method = item.compressionMethod ?? 0;
    const compressed = item.compressedData ?? (method === 8 ? deflateRawSync(plain) : plain);
    const uncompressedSize = item.uncompressedSize ?? plain.length;
    const name = Buffer.from(item.name, "utf8");
    const flags = item.flags ?? 0x800;
    const crc = crc32(plain);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(compressed.length), u32(uncompressedSize),
      u16(name.length), u16(0), name, compressed,
    ]);
    localParts.push(local);
    const external = item.externalFileAttributes ?? 0x81a40000;
    const madeBy = item.versionMadeBy ?? ((3 << 8) | 20);
    centralParts.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(madeBy), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(compressed.length), u32(uncompressedSize),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(external), u32(offset), name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0),
  ]);
  await writeFile(archivePath, Buffer.concat([...localParts, central, end]), { flag: "wx", mode: 0o600 });
}

export async function makeV10Bundle(root: string): Promise<string> {
  const bundle = await copyTemplate(root);
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.schema_version = "1.0";
  delete manifest.payload;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const renames: Array<[string, string]> = [
    ["README.md", "readme.md"],
    ["REQUEST.md", "request.md"],
    ["RESEARCH.md", "research.md"],
    ["SOURCES.md", "sources.md"],
    ["PLAN.md", "plan.md"],
    ["RULES.md", "rules.md"],
    ["VALIDATION.md", "validation.md"],
  ];
  for (const [from, to] of renames) {
    await cp(path.join(bundle, from), path.join(bundle, to));
    await rm(path.join(bundle, from));
  }
  await rm(path.join(bundle, "checksums.json"));
  return bundle;
}
