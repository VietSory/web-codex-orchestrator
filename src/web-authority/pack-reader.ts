import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import yauzl from "yauzl";
import {
  DEFAULT_WEB_AUTHORITY_LIMITS,
  REQUIRED_WEB_PACK_ENTRIES,
  WebAuthorityError,
  type WebAuthorityLimits,
  type WebChecksumsDocument,
  type WebImplementationOperation,
  type WebImplementationPack,
  type WebImplementationPackManifest,
  type WebOperationsDocument,
  type WebPreimagesDocument,
  type WebSourceReceiptsDocument,
} from "./contracts.js";

const GPB_ENCRYPTION_BIT = 0x0001;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isSafeBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("//") || value.includes("..") || value.includes("@{") || /[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  return value.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

function assertArchiveEntryPath(entryPath: string): void {
  if (!entryPath || entryPath.includes("\0") || entryPath.includes("\\")) {
    throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_UNSAFE", `Unsafe archive entry path '${entryPath}'.`);
  }
  if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
    throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_UNSAFE", `Absolute archive entry path '${entryPath}' is forbidden.`);
  }
  const normalized = path.posix.normalize(entryPath);
  if (normalized !== entryPath || normalized === ".." || normalized.startsWith("../") || entryPath.endsWith("/")) {
    throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_UNSAFE", `Non-canonical archive entry path '${entryPath}'.`);
  }
}

export function assertRepositoryRelativePath(value: string): void {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Unsafe repository path '${value}'.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Non-canonical repository path '${value}'.`);
  }
  if (value === ".git" || value.startsWith(".git/")) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Git metadata path '${value}' is forbidden.`);
  }
}

function parseJsonObject<T>(entries: ReadonlyMap<string, Buffer>, entryPath: string, code: "WEB_AUTHORITY_MANIFEST_INVALID" | "WEB_AUTHORITY_OPERATION_INVALID" | "WEB_AUTHORITY_PREIMAGE_INVALID" | "WEB_AUTHORITY_SOURCE_INVALID"): T {
  const raw = entries.get(entryPath);
  if (!raw) throw new WebAuthorityError(code, `Missing required entry '${entryPath}'.`);
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object");
    return parsed as T;
  } catch (error) {
    throw new WebAuthorityError(code, `Invalid JSON in '${entryPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0) throw new WebAuthorityError("WEB_AUTHORITY_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (!SAFE_ID.test(taskId) || !SHA256.test(taskBundleSha256)) {
    throw new WebAuthorityError("WEB_AUTHORITY_INVALID_RUN_ID", "run_id contains an invalid task ID or archive SHA-256.");
  }
  return { taskId, taskBundleSha256 };
}

function validateManifest(manifest: WebImplementationPackManifest): void {
  if (manifest.schema_version !== "2.0" || manifest.kind !== "wco-web-implementation-pack") {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Unsupported Web implementation pack schema/kind.");
  }
  if (!SAFE_ID.test(manifest.pack_id)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "pack_id is invalid.");
  const identity = parseRunId(manifest.run_id);
  if (manifest.task_id !== identity.taskId || manifest.task_bundle_sha256 !== identity.taskBundleSha256) {
    throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Manifest task/run identity is inconsistent.");
  }
  if (!SAFE_ID.test(manifest.repository.id) || !isSafeBranchName(manifest.repository.base_branch)) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Repository ID/base branch is invalid.");
  }
  if (!GIT_SHA.test(manifest.repository.base_commit) || !GIT_SHA.test(manifest.repository.tree_sha)) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Repository base_commit/tree_sha must be lowercase 40-character Git object IDs.");
  }
  if (!Number.isFinite(Date.parse(manifest.created_at))) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "created_at must be an ISO-8601 timestamp.");
  }
  for (const [name, value] of Object.entries(manifest.bindings)) {
    if (!SHA256.test(value)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Binding '${name}' is not a SHA-256 digest.`);
  }
}

function validateDocumentBindings(entries: ReadonlyMap<string, Buffer>, manifest: WebImplementationPackManifest): void {
  const files: Array<[keyof WebImplementationPackManifest["bindings"], string]> = [
    ["repository_inventory_sha256", "repository-inventory.json"],
    ["read_coverage_sha256", "read-coverage.json"],
    ["project_map_sha256", "project-map.json"],
    ["source_receipts_sha256", "source-receipts.json"],
    ["preimages_sha256", "preimages.json"],
    ["architecture_lock_sha256", "architecture-lock.json"],
    ["acceptance_lock_sha256", "acceptance-lock.json"],
    ["prohibited_changes_sha256", "prohibited-changes.json"],
    ["operations_sha256", "operations.json"],
  ];
  for (const [binding, filename] of files) {
    const buffer = entries.get(filename);
    if (!buffer || sha256(buffer) !== manifest.bindings[binding]) {
      throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Manifest binding '${binding}' does not match '${filename}'.`);
    }
  }
}

function validateChecksums(entries: ReadonlyMap<string, Buffer>): void {
  const checksums = parseJsonObject<WebChecksumsDocument>(entries, "checksums.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  if (checksums.schema_version !== "2.0" || checksums.algorithm !== "sha256" || !Array.isArray(checksums.entries)) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "checksums.json schema is invalid.");
  }
  const expectedPaths = [...entries.keys()].filter((value) => value !== "checksums.json").sort();
  const actualPaths = checksums.entries.map((entry) => entry.path);
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((value, index) => value !== expectedPaths[index])) {
    throw new WebAuthorityError("WEB_AUTHORITY_CHECKSUM_MISMATCH", "checksums.json must cover every non-checksum entry exactly once in lexical order.");
  }
  for (const expected of checksums.entries) {
    const actual = entries.get(expected.path);
    if (!actual || !SHA256.test(expected.sha256) || expected.sha256 !== sha256(actual) || expected.size_bytes !== actual.byteLength) {
      throw new WebAuthorityError("WEB_AUTHORITY_CHECKSUM_MISMATCH", `Checksum/size mismatch for '${expected.path}'.`);
    }
  }
}

function validateOperations(entries: ReadonlyMap<string, Buffer>, limits: WebAuthorityLimits): { operations: WebOperationsDocument; preimages: WebPreimagesDocument } {
  const operations = parseJsonObject<WebOperationsDocument>(entries, "operations.json", "WEB_AUTHORITY_OPERATION_INVALID");
  const preimages = parseJsonObject<WebPreimagesDocument>(entries, "preimages.json", "WEB_AUTHORITY_PREIMAGE_INVALID");
  if (operations.schema_version !== "2.0" || !Array.isArray(operations.operations) || operations.operations.length > limits.maximum_operations) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", "operations.json schema/count is invalid.");
  }
  if (preimages.schema_version !== "2.0" || !Array.isArray(preimages.entries)) {
    throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", "preimages.json schema is invalid.");
  }
  const preimageMap = new Map<string, string | null>();
  for (const entry of preimages.entries) {
    assertRepositoryRelativePath(entry.path);
    if (preimageMap.has(entry.path) || entry.sha256 !== null && !SHA256.test(entry.sha256)) {
      throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Invalid/duplicate preimage for '${entry.path}'.`);
    }
    preimageMap.set(entry.path, entry.sha256);
  }
  const opIds = new Set<string>();
  const paths = new Set<string>();
  for (const operation of operations.operations) validateOperation(operation, entries, opIds, paths, preimageMap);
  if (preimageMap.size !== paths.size) {
    throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", "preimages.json must contain exactly one entry for every operation path.");
  }
  return { operations, preimages };
}

function validateOperation(operation: WebImplementationOperation, entries: ReadonlyMap<string, Buffer>, opIds: Set<string>, paths: Set<string>, preimages: Map<string, string | null>): void {
  if (!SAFE_ID.test(operation.op_id) || opIds.has(operation.op_id)) throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Invalid/duplicate op_id '${operation.op_id}'.`);
  opIds.add(operation.op_id);
  if (!["create_file", "replace_file", "delete_file"].includes(operation.kind)) throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Unsupported operation kind '${String(operation.kind)}'.`);
  assertRepositoryRelativePath(operation.path);
  if (paths.has(operation.path)) throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Multiple operations target '${operation.path}'.`);
  paths.add(operation.path);
  if (preimages.get(operation.path) !== operation.preimage_sha256) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Operation/preimage mismatch for '${operation.path}'.`);
  if (operation.kind === "create_file") {
    if (operation.preimage_sha256 !== null) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `create_file '${operation.path}' must have null preimage.`);
  } else if (!operation.preimage_sha256 || !SHA256.test(operation.preimage_sha256)) {
    throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `${operation.kind} '${operation.path}' requires an exact SHA-256 preimage.`);
  }
  if (operation.kind === "delete_file") {
    if (operation.payload_entry !== undefined || operation.payload_sha256 !== undefined) throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `delete_file '${operation.path}' must not carry a payload.`);
    return;
  }
  if (!operation.payload_entry || !operation.payload_entry.startsWith("payload/") || !operation.payload_sha256 || !SHA256.test(operation.payload_sha256)) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `${operation.kind} '${operation.path}' requires a payload entry and SHA-256.`);
  }
  assertArchiveEntryPath(operation.payload_entry);
  const payload = entries.get(operation.payload_entry);
  if (!payload || sha256(payload) !== operation.payload_sha256) throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Payload binding mismatch for '${operation.path}'.`);
}

function validateSources(entries: ReadonlyMap<string, Buffer>, limits: WebAuthorityLimits): WebSourceReceiptsDocument {
  const sources = parseJsonObject<WebSourceReceiptsDocument>(entries, "source-receipts.json", "WEB_AUTHORITY_SOURCE_INVALID");
  if (sources.schema_version !== "2.0" || !Array.isArray(sources.receipts) || sources.receipts.length > limits.maximum_source_receipts) {
    throw new WebAuthorityError("WEB_AUTHORITY_SOURCE_INVALID", "source-receipts.json schema/count is invalid.");
  }
  const ids = new Set<string>();
  for (const receipt of sources.receipts) {
    if (!SAFE_ID.test(receipt.source_id) || ids.has(receipt.source_id) || !receipt.locator || receipt.locator.length > 4096 || !SHA256.test(receipt.content_sha256) || !Number.isFinite(Date.parse(receipt.accessed_at))) {
      throw new WebAuthorityError("WEB_AUTHORITY_SOURCE_INVALID", `Invalid source receipt '${receipt.source_id}'.`);
    }
    ids.add(receipt.source_id);
  }
  return sources;
}

function validateSnapshotDocuments(entries: ReadonlyMap<string, Buffer>, manifest: WebImplementationPackManifest): void {
  const inventory = parseJsonObject<Record<string, unknown>>(entries, "repository-inventory.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  const coverage = parseJsonObject<Record<string, unknown>>(entries, "read-coverage.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  const projectMap = parseJsonObject<Record<string, unknown>>(entries, "project-map.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  for (const [label, doc] of [["repository-inventory", inventory], ["read-coverage", coverage], ["project-map", projectMap]] as const) {
    if (doc.schema_version !== "2.0" || doc.repository_tree_sha !== manifest.repository.tree_sha) {
      throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `${label}.json is not bound to the manifest repository tree.`);
    }
  }
  const architecture = parseJsonObject<Record<string, unknown>>(entries, "architecture-lock.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  const acceptance = parseJsonObject<Record<string, unknown>>(entries, "acceptance-lock.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  const prohibited = parseJsonObject<Record<string, unknown>>(entries, "prohibited-changes.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  if (architecture.schema_version !== "2.0" || acceptance.schema_version !== "2.0" || prohibited.schema_version !== "2.0") {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Lock/prohibited-change documents must use schema_version 2.0.");
  }
  if (architecture.spec_set_sha256 !== manifest.bindings.spec_set_sha256 || acceptance.spec_set_sha256 !== manifest.bindings.spec_set_sha256) {
    throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Architecture/acceptance locks do not bind the declared spec_set_sha256.");
  }
  if (!Array.isArray(prohibited.paths) || !Array.isArray(prohibited.rules)) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "prohibited-changes.json must contain paths[] and rules[].");
  }
}

async function hashArchive(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function readZip(filePath: string, limits: WebAuthorityLimits): Promise<{ entries: Map<string, Buffer>; count: number; total: number }> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (openError, zipfile) => {
      if (openError || !zipfile) return reject(new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", `Cannot open Web pack: ${openError?.message ?? "unknown"}`));
      if (zipfile.comment && zipfile.comment.length > 0) { zipfile.close(); return reject(new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", "Archive comments are forbidden.")); }
      const entries = new Map<string, Buffer>();
      const normalized = new Set<string>();
      let count = 0;
      let total = 0;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error instanceof WebAuthorityError ? error : new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", error instanceof Error ? error.message : String(error)));
      };
      zipfile.once("error", fail);
      zipfile.on("entry", (entry: yauzl.Entry) => {
        try {
          assertArchiveEntryPath(entry.fileName);
          if (entry.generalPurposeBitFlag & GPB_ENCRYPTION_BIT) throw new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", `Encrypted entry '${entry.fileName}' is forbidden.`);
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", `Unsupported compression method for '${entry.fileName}'.`);
          const mode = entry.externalFileAttributes >>> 16;
          const fileType = mode & 0o170000;
          if (fileType !== 0 && fileType !== 0o100000) throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_UNSAFE", `Non-regular ZIP entry '${entry.fileName}' is forbidden.`);
          const key = entry.fileName.normalize("NFC").toLowerCase();
          if (normalized.has(key) || entries.has(entry.fileName)) throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_UNSAFE", `Duplicate/colliding entry '${entry.fileName}'.`);
          normalized.add(key);
          count += 1;
          if (count > limits.maximum_entries) throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_LIMIT", `Archive exceeds ${limits.maximum_entries} entries.`);
          if (entry.uncompressedSize > limits.maximum_entry_bytes) throw new WebAuthorityError("WEB_AUTHORITY_ENTRY_TOO_LARGE", `Entry '${entry.fileName}' exceeds the byte limit.`);
          if (total + entry.uncompressedSize > limits.maximum_total_uncompressed_bytes) throw new WebAuthorityError("WEB_AUTHORITY_TOTAL_TOO_LARGE", "Archive declared uncompressed size exceeds the limit.");
        } catch (error) { fail(error); return; }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", `Cannot read '${entry.fileName}'.`)); return; }
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > limits.maximum_entry_bytes || total + bytes > limits.maximum_total_uncompressed_bytes) {
              stream.destroy(new WebAuthorityError("WEB_AUTHORITY_ENTRY_TOO_LARGE", `Entry '${entry.fileName}' exceeded its bounded stream limit.`));
              return;
            }
            chunks.push(chunk);
          });
          stream.once("error", fail);
          stream.once("end", () => {
            if (settled) return;
            if (bytes !== entry.uncompressedSize) { fail(new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", `Entry size changed while reading '${entry.fileName}'.`)); return; }
            total += bytes;
            entries.set(entry.fileName, Buffer.concat(chunks, bytes));
            zipfile.readEntry();
          });
        });
      });
      zipfile.once("end", () => {
        if (settled) return;
        settled = true;
        zipfile.close();
        resolve({ entries, count, total });
      });
      zipfile.readEntry();
    });
  });
}

export async function readAndValidateWebImplementationPack(filePath: string, overrides: Partial<WebAuthorityLimits> = {}): Promise<WebImplementationPack> {
  const limits = { ...DEFAULT_WEB_AUTHORITY_LIMITS, ...overrides };
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebAuthorityError("WEB_AUTHORITY_INPUT_NOT_FOUND", `Web implementation pack not found: ${filePath}`);
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", `Cannot inspect Web implementation pack: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink()) throw new WebAuthorityError("WEB_AUTHORITY_INPUT_SYMLINK", "Web implementation pack must not be a symbolic link.");
  if (!stat.isFile()) throw new WebAuthorityError("WEB_AUTHORITY_INPUT_NOT_REGULAR", "Web implementation pack must be a regular file.");
  if (stat.size > limits.maximum_archive_bytes) throw new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_TOO_LARGE", `Web implementation pack exceeds ${limits.maximum_archive_bytes} bytes.`);
  const before = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  const archiveSha256 = await hashArchive(filePath);
  const zip = await readZip(filePath, limits);
  const after = fs.lstatSync(filePath);
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new WebAuthorityError("WEB_AUTHORITY_ARCHIVE_INVALID", "Web implementation pack changed while it was being validated.");
  }
  for (const required of REQUIRED_WEB_PACK_ENTRIES) if (!zip.entries.has(required)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Missing required entry '${required}'.`);
  validateChecksums(zip.entries);
  const manifest = parseJsonObject<WebImplementationPackManifest>(zip.entries, "implementation-pack.json", "WEB_AUTHORITY_MANIFEST_INVALID");
  validateManifest(manifest);
  validateDocumentBindings(zip.entries, manifest);
  validateSnapshotDocuments(zip.entries, manifest);
  const { operations, preimages } = validateOperations(zip.entries, limits);
  const sources = validateSources(zip.entries, limits);
  return { archive_sha256: archiveSha256, archive_size_bytes: before.size, entry_count: zip.count, uncompressed_size_bytes: zip.total, manifest, operations, preimages, sources, entries: zip.entries };
}
