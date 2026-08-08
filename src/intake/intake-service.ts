import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { validateBundleDirectory } from "../bundle/validator.js";
import { readJsonFile } from "../shared/read-json.js";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "./constants.js";
import type {
  AcceptedIntakeReceipt,
  IntakeErrorCode,
  IntakeErrorDetail,
  IntakeReceipt,
  RejectedIntakeReceipt,
} from "./contracts.js";
import { IntakeError, isIntakeError } from "./errors.js";
import { hashArchive } from "./archive-hash.js";
import { copyStableInputToQuarantine } from "./stable-input.js";
import { verifyBundleChecksums } from "./checksum-verifier.js";
import { resolveLogicalRoot } from "./root-resolver.js";
import { extractArchive, inspectArchive } from "./secure-extractor.js";

const MAX_INTAKE_RECEIPT_BYTES = 1024 * 1024;
const MAX_ACCEPTED_TASK_DIRECTORIES = 4096;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface IntakeOptions {
  limits?: Partial<ArchiveLimits>;
  now?: () => Date;
  createUniqueId?: () => string;
  /** Test seam invoked after input validation and before its stable copy opens. */
  beforeQuarantineCopy?: () => Promise<void> | void;
  /** Test seam invoked only after one streamed file has reached disk. */
  onFileExtracted?: (outputPath: string) => Promise<void> | void;
}

interface IntakeContext {
  stateDirectory: string;
  archivePath: string;
  quarantineDirectory?: string;
  archiveHash?: string;
  archiveBytes?: number;
  entryCount?: number;
  totalUncompressedBytes?: number;
}

function mergedLimits(options: IntakeOptions): ArchiveLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
}

function asPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function detailFromError(error: IntakeError): IntakeErrorDetail {
  const detail: IntakeErrorDetail = { code: error.code, message: error.message };
  if (error.entry !== undefined) detail.entry = error.entry;
  return detail;
}

function isOperationalCode(code: IntakeErrorCode): boolean {
  return code === "OPERATIONAL_ERROR";
}

function operational(error: unknown): IntakeError {
  if (isIntakeError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new IntakeError("OPERATIONAL_ERROR", message);
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new IntakeError("OPERATIONAL_ERROR", `Unsafe lifecycle directory: ${directory}`);
    }
    return;
  } catch (error) {
    if (isIntakeError(error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created = await lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new IntakeError("OPERATIONAL_ERROR", `Unsafe lifecycle directory: ${directory}`);
  }
}

async function ensureStateDirectory(stateDirectory: string): Promise<void> {
  await ensureRealDirectory(stateDirectory);
  await ensureRealDirectory(path.join(stateDirectory, "quarantine"));
  await ensureRealDirectory(path.join(stateDirectory, "accepted"));
  await ensureRealDirectory(path.join(stateDirectory, "rejected"));
}

function resolveContainedDirectory(
  rootDirectory: string,
  segments: string[],
  code: "BUNDLE_CONTRACT_INVALID" | "OPERATIONAL_ERROR",
  message: string,
): string {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new IntakeError(code, message);
  }
  return target;
}

async function readStableReceiptBytes(receiptPath: string): Promise<Buffer | undefined> {
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IntakeError("OPERATIONAL_ERROR", `Cannot inspect intake receipt: ${receiptPath}`);
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_INTAKE_RECEIPT_BYTES) {
    throw new IntakeError("OPERATIONAL_ERROR", "Intake receipt must be a bounded regular non-symlink file.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(receiptPath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new IntakeError("OPERATIONAL_ERROR", `Cannot safely open intake receipt: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_INTAKE_RECEIPT_BYTES) {
      throw new IntakeError("OPERATIONAL_ERROR", "Intake receipt changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new IntakeError("OPERATIONAL_ERROR", "Intake receipt was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new IntakeError("OPERATIONAL_ERROR", "Intake receipt grew while reading.");
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(receiptPath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new IntakeError("OPERATIONAL_ERROR", "Intake receipt changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedStringArray(value: unknown, maximumItems = 256, maximumChars = 4096): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => typeof item === "string" && item.length <= maximumChars);
}

function parseReceipt(bytes: Buffer): IntakeReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new IntakeError("OPERATIONAL_ERROR", "Persisted intake receipt is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntakeError("OPERATIONAL_ERROR", "Persisted intake receipt must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.receipt_version !== "1.0" || !validTimestamp(record.created_at) || !boundedStringArray(record.checks)) {
    throw new IntakeError("OPERATIONAL_ERROR", "Persisted intake receipt has an invalid common schema.");
  }
  if (record.status === "accepted") {
    if (
      typeof record.task_id !== "string" || !SAFE_TASK_ID.test(record.task_id) ||
      !["1.0", "1.1", "1.2", "1.3"].includes(String(record.bundle_schema_version)) ||
      typeof record.archive_sha256 !== "string" || !SHA256.test(record.archive_sha256) ||
      !Number.isSafeInteger(record.archive_bytes) || Number(record.archive_bytes) < 0 ||
      !Number.isSafeInteger(record.entry_count) || Number(record.entry_count) < 0 ||
      !Number.isSafeInteger(record.total_uncompressed_bytes) || Number(record.total_uncompressed_bytes) < 0 ||
      typeof record.logical_root !== "string" || record.logical_root.length > 4096 ||
      typeof record.stored_bundle !== "string" || record.stored_bundle.length > 8192 ||
      !Array.isArray(record.errors) || record.errors.length !== 0
    ) {
      throw new IntakeError("OPERATIONAL_ERROR", "Persisted accepted intake receipt has an invalid schema.");
    }
    return record as unknown as AcceptedIntakeReceipt;
  }
  if (record.status === "rejected") {
    if (
      record.archive_sha256 !== undefined && (typeof record.archive_sha256 !== "string" || !SHA256.test(record.archive_sha256)) ||
      record.archive_bytes !== undefined && (!Number.isSafeInteger(record.archive_bytes) || Number(record.archive_bytes) < 0) ||
      record.entry_count !== undefined && (!Number.isSafeInteger(record.entry_count) || Number(record.entry_count) < 0) ||
      record.total_uncompressed_bytes !== undefined && (!Number.isSafeInteger(record.total_uncompressed_bytes) || Number(record.total_uncompressed_bytes) < 0) ||
      !Array.isArray(record.errors) || record.errors.length < 1 || record.errors.length > 256 ||
      record.errors.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof (item as { code?: unknown }).code !== "string" || typeof (item as { message?: unknown }).message !== "string")
    ) {
      throw new IntakeError("OPERATIONAL_ERROR", "Persisted rejected intake receipt has an invalid schema.");
    }
    return record as unknown as RejectedIntakeReceipt;
  }
  throw new IntakeError("OPERATIONAL_ERROR", "Persisted intake receipt has an invalid status.");
}

async function readReceipt(receiptPath: string): Promise<IntakeReceipt | undefined> {
  const bytes = await readStableReceiptBytes(receiptPath);
  return bytes === undefined ? undefined : parseReceipt(bytes);
}

async function assertRealContainedDirectory(root: string, candidate: string, label: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new IntakeError("OPERATIONAL_ERROR", `${label} escapes accepted storage.`);
  }
  const info = await lstat(resolved).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new IntakeError("OPERATIONAL_ERROR", `${label} is missing or unsafe.`);
  }
  const [canonicalRoot, canonical] = await Promise.all([realpath(resolvedRoot), realpath(resolved)]);
  const canonicalRelative = path.relative(canonicalRoot, canonical);
  if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new IntakeError("OPERATIONAL_ERROR", `${label} realpath escapes accepted storage.`);
  }
}

async function assertAcceptedReceiptAuthority(
  stateDirectory: string,
  taskId: string,
  archiveHash: string,
  receipt: AcceptedIntakeReceipt,
): Promise<void> {
  if (receipt.task_id !== taskId || receipt.archive_sha256 !== archiveHash) {
    throw new IntakeError("OPERATIONAL_ERROR", "Accepted intake receipt path identity does not match its body.");
  }
  const acceptedDirectory = path.join(stateDirectory, "accepted", taskId, archiveHash);
  const bundlePath = path.join(acceptedDirectory, "bundle");
  const expectedStoredBundle = asPosixRelative(stateDirectory, bundlePath);
  if (receipt.stored_bundle !== expectedStoredBundle) {
    throw new IntakeError("OPERATIONAL_ERROR", "Accepted intake receipt stored_bundle is not the canonical task/archive bundle path.");
  }
  await assertRealContainedDirectory(path.join(stateDirectory, "accepted"), acceptedDirectory, "Accepted task/archive directory");
  await assertRealContainedDirectory(path.join(stateDirectory, "accepted"), bundlePath, "Accepted bundle directory");
  const sourceZip = path.join(acceptedDirectory, "source.zip");
  const sourceInfo = await lstat(sourceZip).catch(() => undefined);
  if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new IntakeError("OPERATIONAL_ERROR", "Accepted source archive is missing or unsafe.");
  }
  if (await hashArchive(sourceZip) !== archiveHash) {
    throw new IntakeError("OPERATIONAL_ERROR", "Accepted source archive no longer matches the receipt archive SHA-256.");
  }
  if (receipt.bundle_schema_version !== "1.0") await verifyBundleChecksums(bundlePath);
  const validation = await validateBundleDirectory(bundlePath);
  if (!validation.ok || validation.manifest?.task_id !== taskId || validation.manifest?.schema_version !== receipt.bundle_schema_version) {
    throw new IntakeError("OPERATIONAL_ERROR", "Accepted bundle no longer matches the persisted intake authority.");
  }
}

function assertRejectedReceiptAuthority(archiveHash: string, receipt: RejectedIntakeReceipt): void {
  if (receipt.archive_sha256 !== archiveHash) {
    throw new IntakeError("OPERATIONAL_ERROR", "Rejected intake receipt path identity does not match its body.");
  }
}

async function findExistingReceipt(stateDirectory: string, archiveHash: string): Promise<IntakeReceipt | undefined> {
  const rejectedPath = path.join(stateDirectory, "rejected", archiveHash, "rejection.json");
  const rejected = await readReceipt(rejectedPath);
  if (rejected) {
    if (rejected.status !== "rejected") throw new IntakeError("OPERATIONAL_ERROR", "Rejected receipt path contains an accepted receipt.");
    assertRejectedReceiptAuthority(archiveHash, rejected);
    return rejected;
  }

  let entries;
  try {
    entries = await readdir(path.join(stateDirectory, "accepted"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (entries.length > MAX_ACCEPTED_TASK_DIRECTORIES) {
    throw new IntakeError("OPERATIONAL_ERROR", `Accepted task registry exceeds ${MAX_ACCEPTED_TASK_DIRECTORIES} directories.`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_TASK_ID.test(entry.name)) continue;
    const candidate = path.join(stateDirectory, "accepted", entry.name, archiveHash, "intake.json");
    const receipt = await readReceipt(candidate);
    if (!receipt) continue;
    if (receipt.status !== "accepted") throw new IntakeError("OPERATIONAL_ERROR", "Accepted receipt path contains a rejected receipt.");
    await assertAcceptedReceiptAuthority(stateDirectory, entry.name, archiveHash, receipt);
    return receipt;
  }
  return undefined;
}

function rejectedReceipt(
  context: IntakeContext,
  detail: IntakeErrorDetail,
  now: () => Date,
): RejectedIntakeReceipt {
  const receipt: RejectedIntakeReceipt = {
    receipt_version: "1.0",
    status: "rejected",
    checks: [],
    errors: [detail],
    created_at: now().toISOString(),
  };
  if (context.archiveHash !== undefined) receipt.archive_sha256 = context.archiveHash;
  if (context.archiveBytes !== undefined) receipt.archive_bytes = context.archiveBytes;
  if (context.entryCount !== undefined) receipt.entry_count = context.entryCount;
  if (context.totalUncompressedBytes !== undefined) {
    receipt.total_uncompressed_bytes = context.totalUncompressedBytes;
  }
  return receipt;
}

async function persistRejected(
  context: IntakeContext,
  detail: IntakeErrorDetail,
  now: () => Date,
): Promise<RejectedIntakeReceipt> {
  if (!context.archiveHash || !context.quarantineDirectory) {
    throw new IntakeError("OPERATIONAL_ERROR", detail.message);
  }
  const finalDirectory = resolveContainedDirectory(
    path.join(context.stateDirectory, "rejected"),
    [context.archiveHash],
    "OPERATIONAL_ERROR",
    "Rejected archive escapes rejected storage.",
  );
  const existing = await readReceipt(path.join(finalDirectory, "rejection.json"));
  if (existing) {
    if (existing.status !== "rejected") throw new IntakeError("OPERATIONAL_ERROR", "Rejected receipt path contains an accepted receipt.");
    assertRejectedReceiptAuthority(context.archiveHash, existing);
    return existing;
  }

  const staging = path.join(context.quarantineDirectory, "rejected");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await rename(path.join(context.quarantineDirectory, "source.zip"), path.join(staging, "source.zip"));
  } catch {
    // For an error before the source copy, there is no untrusted archive to retain.
  }
  const receipt = rejectedReceipt(context, detail, now);
  await writeFile(path.join(staging, "rejection.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
  try {
    await rename(staging, finalDirectory);
  } catch (error) {
    const raceReceipt = await readReceipt(path.join(finalDirectory, "rejection.json"));
    if (raceReceipt?.status === "rejected") {
      assertRejectedReceiptAuthority(context.archiveHash, raceReceipt);
      return raceReceipt;
    }
    throw error;
  }
  return receipt;
}

async function persistAccepted(
  context: IntakeContext,
  taskId: string,
  bundleSchemaVersion: "1.0" | "1.1" | "1.2" | "1.3",
  logicalRoot: string,
  checks: string[],
  inspection: { entryCount: number; totalUncompressedBytes: number },
  now: () => Date,
): Promise<AcceptedIntakeReceipt> {
  if (!context.archiveHash || !context.quarantineDirectory) {
    throw new IntakeError("OPERATIONAL_ERROR", "Cannot persist accepted bundle without an archive hash.");
  }
  const finalDirectory = resolveContainedDirectory(
    path.join(context.stateDirectory, "accepted"),
    [taskId, context.archiveHash],
    "BUNDLE_CONTRACT_INVALID",
    "Task ID escapes accepted storage.",
  );
  const existing = await readReceipt(path.join(finalDirectory, "intake.json"));
  if (existing) {
    if (existing.status !== "accepted") throw new IntakeError("OPERATIONAL_ERROR", "Accepted receipt path contains a rejected receipt.");
    await assertAcceptedReceiptAuthority(context.stateDirectory, taskId, context.archiveHash, existing);
    return existing;
  }

  const staging = path.join(context.quarantineDirectory, "accepted");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await rename(path.join(context.quarantineDirectory, "source.zip"), path.join(staging, "source.zip"));

  const extracted = path.join(context.quarantineDirectory, "extracting");
  const bundleSource = logicalRoot === "." ? extracted : path.join(extracted, logicalRoot);
  await rename(bundleSource, path.join(staging, "bundle"));

  const receipt: AcceptedIntakeReceipt = {
    receipt_version: "1.0",
    status: "accepted",
    task_id: taskId,
    bundle_schema_version: bundleSchemaVersion,
    archive_sha256: context.archiveHash,
    archive_bytes: context.archiveBytes ?? 0,
    entry_count: inspection.entryCount,
    total_uncompressed_bytes: inspection.totalUncompressedBytes,
    logical_root: logicalRoot,
    stored_bundle: asPosixRelative(context.stateDirectory, path.join(finalDirectory, "bundle")),
    checks,
    errors: [],
    created_at: now().toISOString(),
  };
  await writeFile(path.join(staging, "intake.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
  try {
    await rename(staging, finalDirectory);
  } catch (error) {
    const raceReceipt = await readReceipt(path.join(finalDirectory, "intake.json"));
    if (raceReceipt?.status === "accepted") {
      await assertAcceptedReceiptAuthority(context.stateDirectory, taskId, context.archiveHash, raceReceipt);
      return raceReceipt;
    }
    throw error;
  }
  return receipt;
}

async function validateInput(
  archivePath: string,
): Promise<void> {
  let info;
  try {
    info = await lstat(archivePath);
  } catch {
    throw new IntakeError("INPUT_NOT_FOUND", `Input archive does not exist: ${archivePath}`);
  }
  if (info.isSymbolicLink()) throw new IntakeError("INPUT_SYMLINK", "Input archive must not be a symbolic link.");
  if (!info.isFile()) throw new IntakeError("INPUT_NOT_REGULAR_FILE", "Input archive must be a regular file.");
  if (!archivePath.toLowerCase().endsWith(".zip")) {
    throw new IntakeError("INPUT_NOT_ZIP", "Input filename must end in .zip.");
  }
}

/** Secure ZIP intake. It only inspects, extracts, hashes and validates metadata. */
export async function intakeArchive(
  archivePath: string,
  stateDirectory: string,
  options: IntakeOptions = {},
): Promise<IntakeReceipt> {
  const limits = mergedLimits(options);
  const now = options.now ?? (() => new Date());
  const createUniqueId = options.createUniqueId ?? randomUUID;
  const context: IntakeContext = {
    stateDirectory: path.resolve(stateDirectory),
    archivePath: path.resolve(archivePath),
  };

  try {
    await validateInput(context.archivePath);
    await ensureStateDirectory(context.stateDirectory);

    context.quarantineDirectory = path.join(
      context.stateDirectory,
      "quarantine",
      createUniqueId(),
    );
    await mkdir(context.quarantineDirectory, { recursive: true, mode: 0o700 });
    await options.beforeQuarantineCopy?.();
    const sourceArchive = path.join(context.quarantineDirectory, "source.zip");
    const copied = await copyStableInputToQuarantine(
      context.archivePath,
      sourceArchive,
      limits.maximumArchiveBytes,
    );
    context.archiveBytes = copied.bytes;
    context.archiveHash = await hashArchive(sourceArchive);
    const existing = await findExistingReceipt(context.stateDirectory, context.archiveHash);
    if (existing) {
      await rm(context.quarantineDirectory, { recursive: true, force: true });
      return existing;
    }

    const inspection = await inspectArchive(sourceArchive, limits);
    context.entryCount = inspection.entryCount;
    context.totalUncompressedBytes = inspection.totalUncompressedBytes;
    const extracting = path.join(context.quarantineDirectory, "extracting");
    const extractionOptions = options.onFileExtracted ? { onFileExtracted: options.onFileExtracted } : {};
    await extractArchive(
      sourceArchive,
      extracting,
      inspection.entries,
      limits,
      extractionOptions,
    );

    const root = resolveLogicalRoot(inspection.entries);
    const bundleDirectory = root.rootRelative === "." ? extracting : path.join(extracting, root.rootRelative);
    let schemaVersion: "1.0" | "1.1" | "1.2" | "1.3" = "1.0";
    try {
      const manifest = await readJsonFile(path.join(bundleDirectory, "manifest.json"));
      if (typeof manifest === "object" && manifest !== null && "schema_version" in manifest) {
        const candidate = (manifest as { schema_version?: unknown }).schema_version;
        if (candidate === "1.1" || candidate === "1.2" || candidate === "1.3") schemaVersion = candidate;
      }
    } catch {
      // The directory validator below returns the stable contract error.
    }

    const checks = [
      "archive-input-valid",
      "zip-entries-safe",
      "archive-limits-valid",
    ];
    if (schemaVersion === "1.1" || schemaVersion === "1.2" || schemaVersion === "1.3") {
      await verifyBundleChecksums(bundleDirectory);
      checks.push("checksums-valid");
    } else {
      checks.push("checksums-not-required");
    }

    const validation = await validateBundleDirectory(bundleDirectory);
    if (!validation.ok) {
      const payloadIssue = validation.issues.find((issue) => issue.code === "PAYLOAD_CONTRACT_INVALID");
      throw new IntakeError(
        payloadIssue ? "PAYLOAD_CONTRACT_INVALID" : "BUNDLE_CONTRACT_INVALID",
        validation.errors.join(" "),
      );
    }
    checks.push("bundle-contract-valid");

    const accepted = await persistAccepted(
      context,
      validation.manifest?.task_id ?? "unknown-task",
      validation.manifest?.schema_version ?? schemaVersion,
      root.logicalRoot,
      checks,
      inspection,
      now,
    );
    await rm(context.quarantineDirectory, { recursive: true, force: true });
    return accepted;
  } catch (error) {
    const intakeError = isIntakeError(error) ? error : operational(error);
    if (context.quarantineDirectory) {
      if (!isOperationalCode(intakeError.code)) {
        try {
          return await persistRejected(context, detailFromError(intakeError), now);
        } finally {
          await rm(context.quarantineDirectory, { recursive: true, force: true });
        }
      }
      await rm(context.quarantineDirectory, { recursive: true, force: true });
    }
    if (!isOperationalCode(intakeError.code)) {
      return rejectedReceipt(context, detailFromError(intakeError), now);
    }
    throw intakeError;
  }
}
