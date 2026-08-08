import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { loadPhase4Config, readBundleJson } from "../execution/execution-config.js";
import { assertPhase4ExecutionContract } from "../execution/execution-contract.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { buildCommitMessage, publishPreparedPhase4Run } from "../publish/phase4-publish-service.js";
import type { GitPublishReceipt } from "../publish/contracts.js";
import { OrchestrationError } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";

export async function publishReadyExecutorSnapshot(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<GitPublishReceipt> {
  const ready = await attestReadyExecutorSnapshot(options);
  const config = await loadPhase4Config(options.configPath);
  if (!config.publish) throw new OrchestrationError("ORCHESTRATION_PUBLISH_CONFIG_MISSING", "Trusted publish configuration is required before publication.");
  const bundle = await readBundleJson(ready.source.trusted.runReceipt.accepted_bundle_path);
  const contract = assertPhase4ExecutionContract(bundle.manifest);
  const run = ready.source.trusted.runReceipt;
  if (bundle.manifest.task_id !== run.task_id || bundle.manifest.repository.id !== run.repository_id || bundle.manifest.repository.base_branch !== run.base_branch || bundle.manifest.repository.base_commit !== run.base_commit || contract.delivery.branch_name !== run.branch_name || contract.delivery.remote !== run.remote) throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "Accepted Task Bundle delivery contract no longer matches the canonical run.");

  const runtimeDirectory = path.join(ready.executorDirectory, "publish", "git-runtime");
  const preparedGit = await preparePublishGitSecurity(config.publish.auth, run.remote_url, runtimeDirectory, process.env);
  try {
    const runner = new GitRunner(preparedGit.environment, runtimeDirectory, {
      identity: config.publish.identity,
      auth: { ...config.publish.auth, environment_allowlist: preparedGit.environmentAllowlist },
    });
    const receiptDigest = crypto.createHash("sha256").update(canonicalJsonBuffer(ready.receipt)).digest("hex");
    return await publishPreparedPhase4Run({
      runId: run.run_id,
      taskId: run.task_id,
      executionDirectory: ready.executorDirectory,
      worktreePath: run.worktree_path,
      baseCommit: run.base_commit,
      branchName: run.branch_name,
      remoteName: run.remote,
      allowedRemoteUrl: run.remote_url,
      changeSetSha256: ready.changeSetDigest,
      expectedPaths: ready.changedPaths,
      commitMessage: buildCommitMessage(bundle.manifest),
      allowedBranchPrefix: contract.delivery.allowed_branch_prefix,
      denyDirectPushBranches: contract.delivery.deny_direct_push_branches,
      allowedGeneratedArtifacts: config.verification.allowed_generated_paths,
      phase4ReceiptSha256: receiptDigest,
      inspectVerifiedChangeSet: async () => {
        const current = await attestReadyExecutorSnapshot(options);
        return {
          change_set_sha256: current.changeSetDigest,
          paths: current.changedPaths,
          touched_generated_paths: current.changedPaths.filter((filePath) => config.verification.allowed_generated_paths.includes(filePath)),
        };
      },
      runner,
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    await preparedGit.cleanup();
  }
}
