import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { WebAuthorityError, type ArtifactRegistrationRecord, type WebImplementationPack } from "./contracts.js";
import { readAndValidateWebImplementationPack } from "./pack-reader.js";
import { assertExistingAuthorityFileSafe, prepareAuthorityDirectory, webAuthorityPaths } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REGISTRATION_BYTES = 1_048_576;

async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Registry artifact is not a regular file: ${filePath}`);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (bytesRead === 0) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Registry artifact truncated while hashing: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Registry artifact changed while hashing: ${filePath}`);
    return { sha256: hash.digest("hex"), size: stat.size };
  } finally { await handle.close(); }
}

async function readBoundedStableFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", `Registry record exceeds ${maximumBytes} bytes or is not regular.`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registry record was truncated during read.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registry record grew during read.");
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registry record changed during read.");
    return bytes;
  } finally { await handle.close(); }
}

async function installImmutableTemp(tempPath: string, finalPath: string, expectedSha256: string, expectedSize: number, stateDirectory: string): Promise<void> {
  try {
    await fs.link(tempPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertExistingAuthorityFileSafe(stateDirectory, finalPath);
    const existing = await sha256File(finalPath);
    if (existing.sha256 !== expectedSha256 || existing.size !== expectedSize) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_CONFLICT", `Immutable registry path already exists with different bytes: ${finalPath}`);
  } finally { await fs.unlink(tempPath).catch(() => undefined); }
}

async function copyArchiveImmutable(sourcePath: string, finalPath: string, expectedSha256: string, expectedSize: number, stateDirectory: string): Promise<void> {
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(tempPath, 0o600).catch(() => undefined);
    const copied = await sha256File(tempPath);
    if (copied.sha256 !== expectedSha256 || copied.size !== expectedSize) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_CONFLICT", "Source Web pack changed between validation and registry copy.");
    await installImmutableTemp(tempPath, finalPath, expectedSha256, expectedSize, stateDirectory);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function writeRegistrationImmutable(record: ArtifactRegistrationRecord, finalPath: string, stateDirectory: string): Promise<void> {
  const bytes = canonicalJsonBuffer(record);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
    await installImmutableTemp(tempPath, finalPath, digest, bytes.byteLength, stateDirectory);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function assertRegistrationRecord(record: ArtifactRegistrationRecord, expected: { taskId: string; taskBundleSha256: string; artifactSha256: string; storedRelativePath: string }): void {
  if (record.registry_version !== "1.0" || record.artifact_kind !== "web-implementation-pack" || record.artifact_sha256 !== expected.artifactSha256 || record.task_id !== expected.taskId || record.task_bundle_sha256 !== expected.taskBundleSha256) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration record identity is inconsistent with its registry path.");
  if (!SHA256.test(record.artifact_sha256) || !Number.isSafeInteger(record.artifact_size_bytes) || record.artifact_size_bytes < 0 || record.stored_relative_path !== expected.storedRelativePath) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration record archive metadata is invalid.");
  if (!SAFE_ID.test(record.pack_id) || record.run_id !== `${record.task_id}:${record.task_bundle_sha256}` || !SHA256.test(record.manifest_sha256) || !Number.isFinite(Date.parse(record.registered_at))) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration record run/pack/timestamp metadata is invalid.");
  if (!record.repository || !SAFE_ID.test(record.repository.id) || !record.repository.base_branch || !GIT_SHA.test(record.repository.base_commit) || !GIT_SHA.test(record.repository.tree_sha)) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration repository binding is invalid.");
  if (!record.bindings || Object.values(record.bindings).some((value) => typeof value !== "string" || !SHA256.test(value))) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration digest bindings are invalid.");
}

function manifestSha(pack: WebImplementationPack): string | null {
  const bytes = pack.entries.get("implementation-pack.json");
  return bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
}

function packsHaveSameAuthorityIdentity(left: WebImplementationPack, right: WebImplementationPack): boolean {
  return left.archive_sha256 === right.archive_sha256
    && left.archive_size_bytes === right.archive_size_bytes
    && manifestSha(left) === manifestSha(right)
    && left.manifest.run_id === right.manifest.run_id
    && left.manifest.pack_id === right.manifest.pack_id
    && canonicalJsonBuffer(left.manifest.repository).equals(canonicalJsonBuffer(right.manifest.repository))
    && canonicalJsonBuffer(left.manifest.bindings).equals(canonicalJsonBuffer(right.manifest.bindings));
}

function packMatchesExistingRegistration(record: ArtifactRegistrationRecord, pack: WebImplementationPack): boolean {
  const manifestDigest = manifestSha(pack);
  if (!manifestDigest) return false;
  return record.artifact_sha256 === pack.archive_sha256
    && record.artifact_size_bytes === pack.archive_size_bytes
    && record.run_id === pack.manifest.run_id
    && record.pack_id === pack.manifest.pack_id
    && record.manifest_sha256 === manifestDigest
    && canonicalJsonBuffer(record.repository).equals(canonicalJsonBuffer(pack.manifest.repository))
    && canonicalJsonBuffer(record.bindings).equals(canonicalJsonBuffer(pack.manifest.bindings));
}

export async function registerWebImplementationPackArtifact(options: { stateDirectory: string; sourceArchivePath: string; pack: WebImplementationPack; registeredAt: string }): Promise<ArtifactRegistrationRecord> {
  const sourcePack = options.pack;
  const manifest = sourcePack.manifest;
  const paths = webAuthorityPaths(options.stateDirectory, manifest.task_id, manifest.task_bundle_sha256, sourcePack.archive_sha256);
  await prepareAuthorityDirectory(options.stateDirectory, paths.artifactDirectory);

  const existing = await readArtifactRegistration(options.stateDirectory, manifest.task_id, manifest.task_bundle_sha256, sourcePack.archive_sha256);
  if (existing) {
    if (!packMatchesExistingRegistration(existing, sourcePack)) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_CONFLICT", "Existing registration does not match the validated Web pack.");
    return existing;
  }

  await copyArchiveImmutable(options.sourceArchivePath, paths.archivePath, sourcePack.archive_sha256, sourcePack.archive_size_bytes, options.stateDirectory);
  const registeredPack = await readAndValidateWebImplementationPack(paths.archivePath);
  if (!packsHaveSameAuthorityIdentity(sourcePack, registeredPack)) {
    throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_CONFLICT", "Immutable registry copy does not represent the same validated Web pack authority.");
  }
  const registeredManifestBytes = registeredPack.entries.get("implementation-pack.json");
  if (!registeredManifestBytes) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Registered implementation-pack.json disappeared after validation.");
  const record: ArtifactRegistrationRecord = {
    registry_version: "1.0",
    artifact_kind: "web-implementation-pack",
    artifact_sha256: registeredPack.archive_sha256,
    artifact_size_bytes: registeredPack.archive_size_bytes,
    stored_relative_path: path.relative(path.resolve(options.stateDirectory), paths.archivePath).split(path.sep).join("/"),
    run_id: registeredPack.manifest.run_id,
    task_id: registeredPack.manifest.task_id,
    task_bundle_sha256: registeredPack.manifest.task_bundle_sha256,
    pack_id: registeredPack.manifest.pack_id,
    repository: registeredPack.manifest.repository,
    bindings: registeredPack.manifest.bindings,
    manifest_sha256: crypto.createHash("sha256").update(registeredManifestBytes).digest("hex"),
    registered_at: options.registeredAt,
  };
  await writeRegistrationImmutable(record, paths.registrationPath, options.stateDirectory);
  return record;
}

export async function readArtifactRegistration(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ArtifactRegistrationRecord | null> {
  const paths = webAuthorityPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256);
  try { await assertExistingAuthorityFileSafe(stateDirectory, paths.registrationPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readBoundedStableFile(paths.registrationPath, MAX_REGISTRATION_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration record is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registration record must be a JSON object.");
  const record = parsed as ArtifactRegistrationRecord;
  const expectedStored = path.relative(path.resolve(stateDirectory), paths.archivePath).split(path.sep).join("/");
  assertRegistrationRecord(record, { taskId, taskBundleSha256, artifactSha256, storedRelativePath: expectedStored });
  await assertExistingAuthorityFileSafe(stateDirectory, paths.archivePath);
  const archive = await sha256File(paths.archivePath);
  if (archive.sha256 !== record.artifact_sha256 || archive.size !== record.artifact_size_bytes) throw new WebAuthorityError("WEB_AUTHORITY_REGISTRY_INVALID", "Registered artifact bytes no longer match the registration record.");
  return record;
}
