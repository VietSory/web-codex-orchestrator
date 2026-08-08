import { unlink } from "node:fs/promises";
import path from "node:path";
import { loadPhase4Config, readBundleJson } from "../execution/execution-config.js";
import { assertPhase4ExecutionContract } from "../execution/execution-validator.js";
import { GitRunner } from "../git/git-runner.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { preparePublishGitSecurity, type PreparedPublishGitSecurity } from "../publish/publish-auth.js";
import { publishPreparedPhase4Run } from "../publish/phase4-publish-service.js";
import { GitPublishError, type GitPublishReceipt } from "../publish/contracts.js";
import { OrchestrationError } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";

function boundedCommitMessage(taskId: string, title: string): string {
  const normalizedTitle = title.replace(/[\r\n\t\u0000]+/g, " ").trim();
  const normalizedTask = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  return `Apply verified task ${normalizedTask}${normalizedTitle ? `: ${normalizedTitle}` : ""}`.slice(0, 4_096);
}

function mapTimedOutPublish(error: unknown): never {
  if (error instanceof GitPublishError) {
    const stderrTail = typeof error.details?.stderr_tail === "string" ? error.details.stderr_tail : "";
    if (error.details?.timed_out === true || stderrTail.includes("[WCO git command timed out]")) {
      throw new OrchestrationError("ORCHESTRATION_PUBLISH_TIMEOUT", `Bounded Git publication timed out: ${error.message}`);
    }
  }
  throw error;
}

async function verifyConfiguredIdentity(
  runner: GitRunner,
  worktreePath: string,
  expected: { name: string; email: string },
): Promise<void> {
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] as const) {
    const result = await runner.run(["var", variable], worktreePath);
    if (result.timed_out === true) {
      throw new OrchestrationError("ORCHESTRATION_PUBLISH_TIMEOUT", `Timed out while verifying ${variable}.`);
    }
    if (result.exitCode !== 0) {
      throw new OrchestrationError("ORCHESTRATION_PUBLISH_IDENTITY_INVALID", `Failed to verify ${variable}.`);
    }
    const match = /^(.*)\s+<([^>]+)>\s+\d+\s+[+-]\d+$/.exec(result.stdout.trim());
    if (!match || match[1] !== expected.name || match[2] !== expected.email) {
      throw new OrchestrationError("ORCHESTRATION_PUBLISH_IDENTITY_INVALID", `Git identity mismatch for ${variable}.`);
    }
  }
}

async function cleanupPublishAuth(auth: PreparedPublishGitSecurity): Promise<void> {
  if (auth.mode !== "https_token") return;
  await unlink(auth.askpassScriptPath).catch(() => undefined);
}

export async function publishReadyExecutorSnapshot(options: {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<GitPublishReceipt> {
  const ready = await attestReadyExecutorSnapshot(options);
  const config = await loadPhase4Config(options.configPath);
  if (!config.publish) {
    throw new OrchestrationError("ORCHESTRATION_PUBLISH_CONFIG_MISSING", "Trusted publish configuration is required before publication.");
  }

  const acceptedBundlePath = ready.source.trusted.runReceipt.accepted_bundle_path;
  await verifyBundleChecksums(acceptedBundlePath);
  const bundle = await readBundleJson(acceptedBundlePath);
  const contract = assertPhase4ExecutionContract(bundle.manifest);
  const run = ready.source.trusted.runReceipt;

  if (
    contract.task_id !== run.task_id ||
    contract.repository.id !== run.repository_id ||
    contract.repository.base_branch !== run.base_branch ||
    contract.repository.base_commit !== run.base_commit ||
    contract.delivery.remote !== run.remote ||
    contract.delivery.branch_name !== run.branch_name ||
    contract.delivery.base_branch !== run.base_branch ||
    contract.delivery.draft !== true ||
    contract.delivery.auto_merge !== false ||
    contract.git_policy.allowed_remote !== run.remote ||
    contract.git_policy.allow_force_push !== false ||
    contract.git_policy.allow_remote_branch_delete !== false ||
    contract.git_policy.allow_merge !== false
  ) {
    throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "Accepted Task Bundle delivery contract no longer matches the canonical run.");
  }

  const runtimeDirectory = path.join(ready.executorDirectory, "publish", "git-runtime");
  const auth = await preparePublishGitSecurity(config.publish, run.remote_url, runtimeDirectory, process.env);

  try {
    const runner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth });
    await verifyConfiguredIdentity(runner, run.worktree_path, config.publish.identity);
    try {
      return await publishPreparedPhase4Run({
        runId: run.run_id,
        taskId: run.task_id,
        archiveSha256: run.archive_sha256,
        stateDirectory: options.stateDirectory,
        executionDirectory: ready.executorDirectory,
        worktreePath: run.worktree_path,
        baseCommit: run.base_commit,
        branchName: run.branch_name,
        remoteName: run.remote,
        allowedRemoteUrl: run.remote_url,
        allowedBranchPrefix: contract.git_policy.allowed_branch_prefix,
        denyDirectPushBranches: [...contract.git_policy.deny_direct_push_branches],
        expectedChangeSetSha256: ready.changeSetDigest,
        expectedPaths: ready.changedPaths,
        commitMessage: boundedCommitMessage(contract.task_id, contract.title),
        runner,
        inspectVerifiedChangeSet: async () => {
          const current = await attestReadyExecutorSnapshot(options);
          return { change_set_sha256: current.changeSetDigest, paths: current.changedPaths };
        },
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) {
      mapTimedOutPublish(error);
    }
  } finally {
    await cleanupPublishAuth(auth);
  }
}
