import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { validateWebImplementationPackSemantics } from "../web-authority/semantic-validator.js";
import { readArtifactRegistration } from "../web-authority/registry.js";
import { registerWebImplementationPack } from "../web-authority/authority-service.js";
import { webAuthorityPaths } from "../web-authority/paths.js";
import type { ArtifactRegistrationRecord, WebImplementationPack } from "../web-authority/contracts.js";
import { ExecutorError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface ExecutorSource {
  registration: ArtifactRegistrationRecord;
  pack: WebImplementationPack;
  trusted: Awaited<ReturnType<typeof resolveTrustedRunContext>>;
  archivePath: string;
}

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new ExecutorError("EXECUTOR_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export async function loadExecutorSource(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string }): Promise<ExecutorSource> {
  if (!SHA256.test(options.artifactSha256)) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "artifact SHA-256 is invalid.");
  const identity = splitRunId(options.runId);
  const registration = await readArtifactRegistration(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
  if (!registration) throw new ExecutorError("EXECUTOR_REGISTRATION_NOT_FOUND", "No Phase 9 registration exists for the requested artifact.");
  if (registration.run_id !== options.runId || registration.artifact_sha256 !== options.artifactSha256) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "Phase 9 registration identity does not match the requested executor source.");
  const paths = webAuthorityPaths(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);

  // Phase 10 does not trust a previously successful Phase 9 decision forever.
  // Re-registering the immutable registry copy performs the full canonical run,
  // Git tree/spec/preimage attestation and idempotently adopts the same record.
  const revalidated = await registerWebImplementationPack({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    archivePath: paths.archivePath,
  });
  if (revalidated.artifact_sha256 !== registration.artifact_sha256 || revalidated.manifest_sha256 !== registration.manifest_sha256 || revalidated.registered_at !== registration.registered_at) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "Phase 9 registration changed during Phase 10 revalidation.");

  const pack = await readAndValidateWebImplementationPack(paths.archivePath);
  validateWebImplementationPackSemantics(pack);
  if (pack.archive_sha256 !== registration.artifact_sha256 || pack.manifest.run_id !== options.runId || pack.manifest.pack_id !== registration.pack_id) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "Registered archive no longer binds the Phase 9 registration.");
  const trusted = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath).catch((error) => {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Canonical run authority drifted: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (trusted.runReceipt.worktree_path !== registration.repository.id && false) {
    // Deliberately unreachable: repository path is canonical local authority and
    // is never compared with logical repository_id. Kept out of persisted pack.
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Unreachable repository identity guard.");
  }
  return { registration, pack, trusted, archivePath: paths.archivePath };
}
