import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readArtifactRegistration } from "../web-authority/registry.js";
import type { ArtifactRegistrationRecord } from "../web-authority/contracts.js";
import { ensureRunLedger } from "./controller.js";
import { OrchestrationError } from "./contracts.js";
import { orchestrationPaths } from "./paths.js";
import { withRunLock } from "./run-lock.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BINDING_BYTES = 16 * 1024;

interface SelectedArtifactBinding {
  version: "1.0";
  run_id: string;
  artifact_sha256: string;
  registration_manifest_sha256: string;
  selected_at: string;
}

export interface SelectedArtifactSelection {
  registration: ArtifactRegistrationRecord;
  selected_at: string;
}

function identity(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) {
    throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for artifact binding.");
  }
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

function bindingPath(stateDirectory: string, runId: string): string {
  const id = identity(runId);
  return path.join(
    orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256).directory,
    "selected-artifact.json",
  );
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readStable(filePath: string): Promise<Buffer> {
  const beforePath = await fs.lstat(filePath);
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.size > MAX_BINDING_BYTES) {
    throw new OrchestrationError(
      "ORCHESTRATION_STATE_INVALID",
      "Selected artifact binding is unsafe or oversized.",
    );
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      before.size > MAX_BINDING_BYTES
    ) {
      throw new OrchestrationError(
        "ORCHESTRATION_STATE_INVALID",
        "Selected artifact binding changed before open.",
      );
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw new OrchestrationError(
          "ORCHESTRATION_STATE_INVALID",
          "Selected artifact binding truncated during read.",
        );
      }
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new OrchestrationError(
        "ORCHESTRATION_STATE_INVALID",
        "Selected artifact binding grew during read.",
      );
    }
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterHandle.dev !== before.dev ||
      afterHandle.ino !== before.ino ||
      afterHandle.size !== before.size ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino ||
      afterPath.size !== before.size
    ) {
      throw new OrchestrationError(
        "ORCHESTRATION_STATE_INVALID",
        "Selected artifact binding changed during read.",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseBinding(bytes: Buffer, runId: string): SelectedArtifactBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OrchestrationError(
      "ORCHESTRATION_STATE_INVALID",
      "Selected artifact binding is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OrchestrationError(
      "ORCHESTRATION_STATE_INVALID",
      "Selected artifact binding must be an object.",
    );
  }
  const binding = parsed as SelectedArtifactBinding;
  if (
    binding.version !== "1.0" ||
    binding.run_id !== runId ||
    !SHA256.test(binding.artifact_sha256) ||
    !SHA256.test(binding.registration_manifest_sha256) ||
    !Number.isFinite(Date.parse(binding.selected_at))
  ) {
    throw new OrchestrationError(
      "ORCHESTRATION_STATE_INVALID",
      "Selected artifact binding identity is invalid.",
    );
  }
  return binding;
}

export async function selectRegisteredArtifact(options: {
  stateDirectory: string;
  runId: string;
  artifactSha256: string;
  now?: Date;
}): Promise<ArtifactRegistrationRecord> {
  if (!SHA256.test(options.artifactSha256)) {
    throw new OrchestrationError(
      "ORCHESTRATION_ARTIFACT_INVALID",
      "Selected artifact SHA-256 is invalid.",
    );
  }
  await ensureRunLedger(options.stateDirectory, options.runId, options.now ?? new Date());
  return await withRunLock(options.stateDirectory, options.runId, async () => {
    const id = identity(options.runId);
    const registration = await readArtifactRegistration(
      options.stateDirectory,
      id.taskId,
      id.taskBundleSha256,
      options.artifactSha256,
    );
    if (!registration || registration.run_id !== options.runId) {
      throw new OrchestrationError(
        "ORCHESTRATION_ARTIFACT_INVALID",
        "Selected artifact is not a valid Phase 9 registration for this run.",
      );
    }
    const binding: SelectedArtifactBinding = {
      version: "1.0",
      run_id: options.runId,
      artifact_sha256: registration.artifact_sha256,
      registration_manifest_sha256: registration.manifest_sha256,
      selected_at: (options.now ?? new Date()).toISOString(),
    };
    const filePath = bindingPath(options.stateDirectory, options.runId);
    const bytes = canonicalJsonBuffer(binding);
    if (bytes.byteLength > MAX_BINDING_BYTES) {
      throw new OrchestrationError(
        "ORCHESTRATION_STATE_INVALID",
        "Selected artifact binding exceeds byte cap.",
      );
    }
    const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      const existing = await fs.lstat(filePath).catch((error) =>
        (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error),
      );
      if (existing?.isSymbolicLink()) {
        throw new OrchestrationError(
          "ORCHESTRATION_STATE_INVALID",
          "Selected artifact binding path is a symlink.",
        );
      }
      await fs.rename(temp, filePath);
      await syncDirectory(path.dirname(filePath));
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temp).catch(() => undefined);
    }
    return registration;
  });
}

export async function readSelectedArtifactSelection(
  stateDirectory: string,
  runId: string,
): Promise<SelectedArtifactSelection | null> {
  const filePath = bindingPath(stateDirectory, runId);
  let bytes: Buffer;
  try {
    bytes = await readStable(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const binding = parseBinding(bytes, runId);
  const id = identity(runId);
  const registration = await readArtifactRegistration(
    stateDirectory,
    id.taskId,
    id.taskBundleSha256,
    binding.artifact_sha256,
  );
  if (
    !registration ||
    registration.run_id !== runId ||
    registration.manifest_sha256 !== binding.registration_manifest_sha256
  ) {
    throw new OrchestrationError(
      "ORCHESTRATION_ARTIFACT_INVALID",
      "Selected artifact pointer no longer resolves to the exact registered authority.",
    );
  }
  return { registration, selected_at: binding.selected_at };
}

export async function readSelectedArtifact(
  stateDirectory: string,
  runId: string,
): Promise<ArtifactRegistrationRecord | null> {
  return (await readSelectedArtifactSelection(stateDirectory, runId))?.registration ?? null;
}
