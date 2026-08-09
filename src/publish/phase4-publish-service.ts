import path from "node:path";
import { unlink } from "node:fs/promises";
import { assertPhase4ExecutionContract } from "../execution/execution-validator.js";
import {
  loadPhase4Config,
  readBundleJson,
} from "../execution/execution-config.js";
import { acquireExecutionLock } from "../execution/execution-lock.js";
import {
  executionPaths,
  readExecutionReceipt,
  readPreparationForExecution,
} from "../execution/execution-store.js";
import { calculateChangeSet } from "../execution/change-set.js";
import type { ChangeSet, ExecutionReceipt } from "../execution/contracts.js";
import { GitRunner } from "../git/git-runner.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import {
  GitPublishError,
  type GitCommandRunner,
  type GitPublishReceipt,
  type VerifiedChangeSet,
} from "./contracts.js";
import { GitPublisher } from "./git-publisher.js";
import {
  readGitPublishReceipt,
  writeGitPublishReceipt,
} from "./publish-store.js";
import { preparePublishGitSecurity } from "./publish-auth.js";

export interface Phase4PublishOptions {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}

export interface PreparedPhase4PublishContext {
  runId: string;
  taskId: string;
  archiveSha256: string;
  stateDirectory: string;
  executionDirectory: string;
  worktreePath: string;
  baseCommit: string;
  branchName: string;
  remoteName: string;
  allowedRemoteUrl: string;
  allowedBranchPrefix: string;
  denyDirectPushBranches: string[];
  expectedChangeSetSha256: string;
  expectedPaths: string[];
  commitMessage: string;
  runner: GitCommandRunner;
  inspectVerifiedChangeSet(): Promise<VerifiedChangeSet>;
  now?: () => Date;
}

function exactApprovedDigest(receipt: ExecutionReceipt): string {
  const digest = receipt.change_set_sha256;

  if (
    receipt.state !== "READY_FOR_PUBLISH" ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    receipt.verification.required_commands_passed !== true ||
    receipt.verification.rounds < 1 ||
    receipt.verification.verified_change_set_sha256 !== digest ||
    receipt.internal_reviewer.rounds < 1 ||
    receipt.internal_reviewer.verdict !== "APPROVE" ||
    receipt.internal_reviewer.reviewed_change_set_sha256 !== digest ||
    receipt.final_reviewer.rounds < 1 ||
    receipt.final_reviewer.verdict !== "APPROVE" ||
    receipt.final_reviewer.reviewed_change_set_sha256 !== digest ||
    !receipt.internal_reviewer.latest_thread_id ||
    !receipt.final_reviewer.latest_thread_id ||
    receipt.internal_reviewer.latest_thread_id === receipt.implementer.thread_id ||
    receipt.final_reviewer.latest_thread_id === receipt.implementer.thread_id ||
    receipt.internal_reviewer.latest_thread_id === receipt.final_reviewer.latest_thread_id
  ) {
    throw new GitPublishError(
      "PUBLISH_PHASE4_NOT_READY",
      "The Phase 4 execution receipt is not fully approved for publication.",
    );
  }

  return digest;
}

export function pathsFromApprovedChangeSet(changeSet: ChangeSet): string[] {
  const paths = new Set<string>();
  for (const entry of changeSet.entries) {
    paths.add(entry.path);
    if (entry.old_path) paths.add(entry.old_path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function assertCurrentChangeSet(changeSet: ChangeSet, receipt: ExecutionReceipt, expectedDigest: string): string[] {
  if (
    changeSet.base_commit !== receipt.base_commit ||
    changeSet.branch_name !== receipt.branch_name ||
    changeSet.change_set_sha256 !== expectedDigest
  ) {
    throw new GitPublishError(
      "PUBLISH_CHANGE_SET_STALE",
      "The current worktree does not match the exact Phase 4 approved digest.",
    );
  }
  const paths = pathsFromApprovedChangeSet(changeSet);
  if (paths.length === 0) {
    throw new GitPublishError(
      "PUBLISH_PHASE4_NOT_READY",
      "Phase 4 approved an empty change set, so no product commit can be published.",
    );
  }
  return paths;
}

function boundedCommitMessage(taskId: string, title: string): string {
  const normalizedTitle = title.replace(/[\r\n\t\u0000]+/g, " ").trim();
  const normalizedTask = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const suffix = normalizedTitle.length > 0 ? `: ${normalizedTitle}` : "";
  return `Apply verified task ${normalizedTask}${suffix}`.slice(0, 4_096);
}

export async function publishPreparedPhase4Run(context: PreparedPhase4PublishContext): Promise<GitPublishReceipt> {
  const receiptPath = path.join(context.executionDirectory, "publish", "git-publish.json");
  const previousReceipt = await readGitPublishReceipt(receiptPath);
  const publisher = new GitPublisher({
    runner: context.runner,
    inspectVerifiedChangeSet: context.inspectVerifiedChangeSet,
    persistReceipt: (receipt) => writeGitPublishReceipt(receiptPath, receipt),
    ...(context.now ? { now: context.now } : {}),
  });

  return publisher.publish(
    {
      run_id: context.runId,
      worktree_path: context.worktreePath,
      base_commit: context.baseCommit,
      branch_name: context.branchName,
      remote_name: context.remoteName,
      allowed_remote_url: context.allowedRemoteUrl,
      allowed_branch_prefix: context.allowedBranchPrefix,
      deny_direct_push_branches: context.denyDirectPushBranches,
      expected_change_set_sha256: context.expectedChangeSetSha256,
      expected_paths: context.expectedPaths,
      commit_message: context.commitMessage,
      allow_force_push: false,
      allow_remote_branch_delete: false,
    },
    previousReceipt,
  );
}

export async function publishPhase4Run(options: Phase4PublishOptions): Promise<GitPublishReceipt> {
  const stateDirectory = path.resolve(options.stateDirectory);
  const preparation = await readPreparationForExecution(stateDirectory, options.runId);
  const lock = await acquireExecutionLock(stateDirectory, preparation.archiveSha256);
  let askpassHelperPath: string | undefined;

  try {
    const execution = await readExecutionReceipt(stateDirectory, preparation.taskId, preparation.archiveSha256);
    if (!execution || execution.run_id !== options.runId) {
      throw new GitPublishError(
        "PUBLISH_PHASE4_NOT_READY",
        "The Phase 4 execution receipt is missing or has the wrong identity.",
      );
    }

    const expectedDigest = exactApprovedDigest(execution);
    await verifyBundleChecksums(preparation.receipt.accepted_bundle_path);

    const [bundleData, config] = await Promise.all([
      readBundleJson(preparation.receipt.accepted_bundle_path),
      loadPhase4Config(options.configPath),
    ]);
    const contract = assertPhase4ExecutionContract(bundleData.manifest);

    if (
      contract.task_id !== preparation.taskId ||
      contract.repository.id !== preparation.receipt.repository_id ||
      contract.repository.base_branch !== preparation.receipt.base_branch ||
      contract.repository.base_commit !== execution.base_commit ||
      contract.delivery.remote !== preparation.receipt.remote ||
      contract.delivery.branch_name !== execution.branch_name ||
      contract.delivery.base_branch !== preparation.receipt.base_branch ||
      contract.delivery.draft !== true ||
      contract.delivery.auto_merge !== false ||
      contract.git_policy.allowed_remote !== contract.delivery.remote ||
      contract.git_policy.allow_force_push !== false ||
      contract.git_policy.allow_remote_branch_delete !== false ||
      contract.git_policy.allow_merge !== false
    ) {
      throw new GitPublishError(
        "PUBLISH_PHASE4_NOT_READY",
        "The accepted delivery contract does not match the prepared Phase 4 run.",
      );
    }

    const runtimeDirectory = path.join(stateDirectory, "git-runtime");
    if (!config.publish?.identity) {
      throw new GitPublishError("PUBLISH_IDENTITY_UNAVAILABLE", "Publish identity configuration is missing.");
    }

    const auth = await preparePublishGitSecurity(
      config.publish,
      preparation.receipt.remote_url,
      runtimeDirectory,
      process.env,
    );
    if (auth.mode === "https_token") askpassHelperPath = auth.askpassScriptPath;

    const runner = new GitRunner(process.env, runtimeDirectory, {
      identity: config.publish.identity,
      auth,
      allowedRemoteUrl: preparation.receipt.remote_url,
    });

    const cwd = execution.worktree_path;
    const expectedName = config.publish.identity.name;
    const expectedEmail = config.publish.identity.email;

    const verifyIdentity = async (envVar: string) => {
      const result = await runner.run(["var", envVar], cwd);
      if (result.exitCode !== 0) {
        throw new GitPublishError("PUBLISH_IDENTITY_UNAVAILABLE", `Failed to verify ${envVar}.`);
      }
      const output = result.stdout.trim();
      const match = /^(.*)\s+<([^>]+)>\s+\d+\s+[+-]\d+$/.exec(output);
      if (!match || match[1] !== expectedName || match[2] !== expectedEmail) {
        throw new GitPublishError("PUBLISH_IDENTITY_UNAVAILABLE", `Git identity mismatch for ${envVar}.`);
      }
    };

    await verifyIdentity("GIT_AUTHOR_IDENT");
    await verifyIdentity("GIT_COMMITTER_IDENT");

    const executionDirectory = executionPaths(stateDirectory, preparation.taskId, preparation.archiveSha256).directory;
    const priorPublishReceipt = await readGitPublishReceipt(path.join(executionDirectory, "publish", "git-publish.json"));

    const inspect = async (): Promise<VerifiedChangeSet> => {
      const current = await calculateChangeSet({
        worktreePath: execution.worktree_path,
        baseCommit: execution.base_commit,
        branchName: execution.branch_name,
        runner,
        allowedGeneratedPaths: config.verification.allowed_generated_paths,
      });
      const paths = assertCurrentChangeSet(current, execution, expectedDigest);
      return { change_set_sha256: current.change_set_sha256, paths };
    };

    let expectedPaths: string[];
    if (priorPublishReceipt) {
      expectedPaths = [...priorPublishReceipt.expected_paths];
    } else {
      const initialChangeSet = await calculateChangeSet({
        worktreePath: execution.worktree_path,
        baseCommit: execution.base_commit,
        branchName: execution.branch_name,
        runner,
        allowedGeneratedPaths: config.verification.allowed_generated_paths,
      });
      expectedPaths = assertCurrentChangeSet(initialChangeSet, execution, expectedDigest);
    }

    return await publishPreparedPhase4Run({
      runId: options.runId,
      taskId: preparation.taskId,
      archiveSha256: preparation.archiveSha256,
      stateDirectory,
      executionDirectory,
      worktreePath: execution.worktree_path,
      baseCommit: execution.base_commit,
      branchName: execution.branch_name,
      remoteName: contract.delivery.remote,
      allowedRemoteUrl: preparation.receipt.remote_url,
      allowedBranchPrefix: contract.git_policy.allowed_branch_prefix,
      denyDirectPushBranches: [...contract.git_policy.deny_direct_push_branches],
      expectedChangeSetSha256: expectedDigest,
      expectedPaths,
      commitMessage: boundedCommitMessage(contract.task_id, contract.title),
      runner,
      inspectVerifiedChangeSet: inspect,
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    if (askpassHelperPath) await unlink(askpassHelperPath).catch(() => undefined);
    await lock.release();
  }
}
