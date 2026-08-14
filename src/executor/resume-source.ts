import path from "node:path";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { validateWebImplementationPackSemantics } from "../web-authority/semantic-validator.js";
import { readArtifactRegistration } from "../web-authority/registry.js";
import { webAuthorityPaths } from "../web-authority/paths.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { attestExecutorResumeAuthority } from "./resume-authority.js";
import { readExecutorReceipt } from "./store.js";
import { executorPaths } from "./paths.js";
import type { ExecutorSource } from "./source.js";
import { ExecutorError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new ExecutorError("EXECUTOR_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export function publishedResumeDigestIsAllowed(
  currentDigest: string,
  repairSourceDigest: string | undefined,
  publishedDigest: string,
): boolean {
  return publishedDigest === currentDigest ||
    (repairSourceDigest !== undefined && publishedDigest === repairSourceDigest);
}

/**
 * A Harness run normally resumes at the immutable base commit. After the exact
 * approved snapshot has been published, however, bounded Web/model repair must
 * resume from that exact published commit rather than pretending HEAD is still
 * the base. Never trust HEAD by observation alone: adopt it only when the
 * durable Phase 10 executor and PUSHED receipt bind the same run/base/branch,
 * an allowed exact change-set generation, and one exact remote commit.
 *
 * During the repair-before-republish window, the current executor digest may
 * already be the repaired bytes while publication still binds the repair source
 * digest. After republish, publication binds the current/final digest while the
 * repair receipt intentionally retains its source digest for audit. Both states
 * are valid; every other digest is authority drift.
 */
async function exactPublishedResumeHead(options: {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  taskId: string;
  taskBundleSha256: string;
  baseCommit: string;
  branchName: string;
  remoteName: string;
  remoteUrl: string;
}): Promise<string | undefined> {
  const executor = await readExecutorReceipt(
    options.stateDirectory,
    options.taskId,
    options.taskBundleSha256,
    options.artifactSha256,
  );
  if (!executor || executor.run_id !== options.runId || executor.change_set_digest === null) return undefined;

  const publishPath = path.join(
    executorPaths(options.stateDirectory, options.taskId, options.taskBundleSha256, options.artifactSha256).directory,
    "publish",
    "git-publish.json",
  );
  const publish = await readGitPublishReceipt(publishPath);
  if (!publish) return undefined;
  const publicationBindsAllowedGeneration = publishedResumeDigestIsAllowed(
    executor.change_set_digest,
    executor.repair?.source_change_set_digest,
    publish.change_set_sha256,
  );
  if (
    publish.state !== "PUSHED" ||
    publish.run_id !== options.runId ||
    publish.base_commit !== options.baseCommit ||
    publish.branch_name !== options.branchName ||
    publish.remote_name !== options.remoteName ||
    publish.allowed_remote_url !== options.remoteUrl ||
    !publicationBindsAllowedGeneration ||
    publish.commit_sha === null ||
    publish.remote_branch_sha !== publish.commit_sha
  ) {
    throw new ExecutorError(
      "EXECUTOR_CANONICAL_AUTHORITY_DRIFT",
      "Persisted publication cannot authorize post-publish Harness resume because its exact run/change-set/head binding is inconsistent.",
    );
  }
  return publish.commit_sha;
}

export async function loadExecutorResumeSource(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string; expectedWorktreeHead?: string }): Promise<ExecutorSource> {
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
  const expectedWorktreeHead = options.expectedWorktreeHead ?? await exactPublishedResumeHead({
    runId: options.runId,
    artifactSha256: options.artifactSha256,
    stateDirectory: options.stateDirectory,
    taskId: identity.taskId,
    taskBundleSha256: identity.taskBundleSha256,
    baseCommit: trusted.runReceipt.base_commit,
    branchName: trusted.runReceipt.branch_name,
    remoteName: trusted.runReceipt.remote,
    remoteUrl: trusted.runReceipt.remote_url,
  });
  await attestExecutorResumeAuthority({
    run: trusted.runReceipt,
    trustedRepoPath: trusted.trustedRepoPath,
    registration,
    ...(expectedWorktreeHead ? { expectedWorktreeHead } : {}),
  });
  return { registration, pack, trusted, archivePath: paths.archivePath };
}
