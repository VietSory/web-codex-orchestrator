import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

async function readReceipt(receiptPath: string): Promise<IntakeReceipt | undefined> {
  try {
    return JSON.parse(await readFile(receiptPath, "utf8")) as IntakeReceipt;
  } catch {
    return undefined;
  }
}

async function findExistingReceipt(stateDirectory: string, archiveHash: string): Promise<IntakeReceipt | undefined> {
  const rejectedPath = path.join(stateDirectory, "rejected", archiveHash, "rejection.json");
  const rejected = await readReceipt(rejectedPath);
  if (rejected) return rejected;

  try {
    for (const taskId of await readdir(path.join(stateDirectory, "accepted"))) {
      const candidate = path.join(stateDirectory, "accepted", taskId, archiveHash, "intake.json");
      const receipt = await readReceipt(candidate);
      if (receipt) return receipt;
    }
  } catch {
    // A missing state directory is equivalent to no prior receipt.
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
  if (existing?.status === "rejected") return existing;

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
    if (raceReceipt?.status === "rejected") return raceReceipt;
    throw error;
  }
  return receipt;
}

async function persistAccepted(
  context: IntakeContext,
  taskId: string,
  bundleSchemaVersion: "1.0" | "1.1" | "1.2",
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
  if (existing?.status === "accepted") return existing;

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
    if (raceReceipt?.status === "accepted") return raceReceipt;
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
    let schemaVersion: "1.0" | "1.1" | "1.2" = "1.0";
    try {
      const manifest = await readJsonFile(path.join(bundleDirectory, "manifest.json"));
      if (typeof manifest === "object" && manifest !== null && "schema_version" in manifest) {
        const candidate = (manifest as { schema_version?: unknown }).schema_version;
        if (candidate === "1.1" || candidate === "1.2") schemaVersion = candidate;
      }
    } catch {
      // The directory validator below returns the stable contract error.
    }

    const checks = [
      "archive-input-valid",
      "zip-entries-safe",
      "archive-limits-valid",
    ];
    if (schemaVersion === "1.1" || schemaVersion === "1.2") {
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
