import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import {
  WebAuthorityError,
  type ArtifactRegistrationRecord,
  type WebImplementationOperation,
  type WebImplementationPack,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface PreparedWebOperation {
  op_id: string;
  kind: WebImplementationOperation["kind"];
  relative_path: string;
  absolute_path: string;
  observed_preimage_sha256: string | null;
  payload_sha256: string | null;
  payload_size_bytes: number;
}

export interface WebOperationPreflightPlan {
  schema_version: "1.0";
  run_id: string;
  artifact_sha256: string;
  worktree_root: string;
  operations: PreparedWebOperation[];
  plan_sha256: string;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
    relativePath === ".git" ||
    relativePath.startsWith(".git/")
  ) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Unsafe operation path: ${relativePath}`);
  }
}

async function assertNoSymlinkAncestors(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Operation ancestor is not a real directory: ${relativePath}`);
    }
  }
}

async function readObservedPreimage(root: string, relativePath: string): Promise<string | null> {
  await assertNoSymlinkAncestors(root, relativePath);
  const target = path.join(root, ...relativePath.split("/"));
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Operation target is not a regular non-symlink file: ${relativePath}`);
  }
  return sha256(await fs.readFile(target));
}

function assertRegistrationMatchesPack(record: ArtifactRegistrationRecord, pack: WebImplementationPack): void {
  if (
    record.run_id !== pack.manifest.run_id ||
    record.artifact_sha256 !== pack.archive_sha256 ||
    record.artifact_size_bytes !== pack.archive_size_bytes ||
    canonicalJsonBuffer(record.repository).compare(canonicalJsonBuffer(pack.manifest.repository)) !== 0 ||
    canonicalJsonBuffer(record.bindings).compare(canonicalJsonBuffer(pack.manifest.bindings)) !== 0
  ) {
    throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Registered artifact authority does not match the Web implementation pack.");
  }
}

function payloadForOperation(pack: WebImplementationPack, operation: WebImplementationOperation): Buffer | null {
  if (operation.kind === "delete_file") {
    if (operation.payload_entry !== undefined || operation.payload_sha256 !== undefined) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Delete operation '${operation.op_id}' cannot carry payload fields.`);
    }
    return null;
  }
  if (!operation.payload_entry || !operation.payload_sha256 || !SHA256.test(operation.payload_sha256)) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Operation '${operation.op_id}' is missing a valid payload binding.`);
  }
  const payload = pack.entries.get(operation.payload_entry);
  if (!payload || sha256(payload) !== operation.payload_sha256) {
    throw new WebAuthorityError("WEB_AUTHORITY_CHECKSUM_MISMATCH", `Operation '${operation.op_id}' payload does not match its SHA-256 binding.`);
  }
  return payload;
}

export async function preflightWebOperations(options: {
  worktreeRoot: string;
  registration: ArtifactRegistrationRecord;
  pack: WebImplementationPack;
}): Promise<WebOperationPreflightPlan> {
  assertRegistrationMatchesPack(options.registration, options.pack);
  const root = path.resolve(options.worktreeRoot);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", "Web operation worktree root must be a real directory.");
  }

  const seenPaths = new Set<string>();
  const prepared: PreparedWebOperation[] = [];
  for (const operation of options.pack.operations.operations) {
    assertSafeRelativePath(operation.path);
    if (seenPaths.has(operation.path)) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Multiple Web operations target the same path: ${operation.path}`);
    }
    seenPaths.add(operation.path);

    const observed = await readObservedPreimage(root, operation.path);
    if (observed !== operation.preimage_sha256) {
      throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Preimage mismatch for '${operation.path}'.`);
    }
    if (operation.kind === "create_file" && observed !== null) {
      throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Create target already exists: ${operation.path}`);
    }
    if ((operation.kind === "replace_file" || operation.kind === "delete_file") && observed === null) {
      throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Required target is missing: ${operation.path}`);
    }

    const payload = payloadForOperation(options.pack, operation);
    prepared.push({
      op_id: operation.op_id,
      kind: operation.kind,
      relative_path: operation.path,
      absolute_path: path.join(root, ...operation.path.split("/")),
      observed_preimage_sha256: observed,
      payload_sha256: payload ? sha256(payload) : null,
      payload_size_bytes: payload?.byteLength ?? 0,
    });
  }

  const planCore = {
    schema_version: "1.0" as const,
    run_id: options.pack.manifest.run_id,
    artifact_sha256: options.pack.archive_sha256,
    worktree_root: root,
    operations: prepared,
  };
  return {
    ...planCore,
    plan_sha256: sha256(canonicalJsonBuffer(planCore)),
  };
}
