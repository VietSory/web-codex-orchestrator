import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { validateWebImplementationPackSemantics } from "../web-authority/semantic-validator.js";
import { readArtifactRegistration } from "../web-authority/registry.js";
import { webAuthorityPaths } from "../web-authority/paths.js";
import { attestExecutorResumeAuthority } from "./resume-authority.js";
import type { ExecutorSource } from "./source.js";
import { ExecutorError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new ExecutorError("EXECUTOR_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export async function loadExecutorResumeSource(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string }): Promise<ExecutorSource> {
  if (!SHA256.test(options.artifactSha256)) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "artifact SHA-256 is invalid.");
  const identity = splitRunId(options.runId);
  const registration = await readArtifactRegistration(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
  if (!registration) throw new ExecutorError("EXECUTOR_REGISTRATION_NOT_FOUND", "No Phase 9 registration exists for resume.");
  if (registration.run_id !== options.runId || registration.artifact_sha256 !== options.artifactSha256) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "Resume registration identity does not match the requested source.");
  const paths = webAuthorityPaths(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
  const pack = await readAndValidateWebImplementationPack(paths.archivePath);
  validateWebImplementationPackSemantics(pack);
  if (pack.archive_sha256 !== registration.artifact_sha256 || pack.manifest.run_id !== registration.run_id || pack.manifest.pack_id !== registration.pack_id) throw new ExecutorError("EXECUTOR_REGISTRATION_INVALID", "Registered archive no longer binds resume registration.");
  const trusted = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath).catch((error) => {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Canonical run authority drifted during resume: ${error instanceof Error ? error.message : String(error)}`);
  });
  await attestExecutorResumeAuthority({ run: trusted.runReceipt, trustedRepoPath: trusted.trustedRepoPath, registration });
  return { registration, pack, trusted, archivePath: paths.archivePath };
}
