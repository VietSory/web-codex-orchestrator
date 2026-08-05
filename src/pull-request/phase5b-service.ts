import path from "node:path";
import crypto from "node:crypto";
import { acquireExecutionLock } from "../execution/execution-lock.js";
import { readExecutionReceipt, readPreparationForExecution } from "../execution/execution-store.js";
import { loadPhase4Config, readBundleJson } from "../execution/execution-config.js";
import { assertPhase4ExecutionContract } from "../execution/execution-validator.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { GitRunner } from "../git/git-runner.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { DraftPullRequestError, type DraftPullRequestReceipt } from "./contracts.js";
import { parseGitHubRepositoryRemote } from "./github-remote.js";
import { GitHubRestPullRequestClient } from "./github-rest-client.js";
import { readDraftPullRequestReceipt, writeDraftPullRequestReceipt } from "./draft-pr-store.js";
import { DraftPullRequestStateMachine } from "./draft-pr-service.js";

export interface Phase5BDraftPrOptions {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}

export interface PreparedDraftPullRequestContext {
  runId: string;
  taskId: string;
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  expectedHeadSha: string;
  changeSetSha256: string;
  gitPublishReceiptSha256: string;
  client: GitHubRestPullRequestClient;
  existingReceipt: DraftPullRequestReceipt | null;
  stateDirectory: string;
  gitRunner: { run(args: string[], cwd: string): Promise<{ stdout: string }> };
  worktreePath: string;
  remoteName: string;
  now?: () => Date;
}

export async function createPreparedDraftPullRequest(context: PreparedDraftPullRequestContext): Promise<DraftPullRequestReceipt> {
  const storePath = path.join(context.stateDirectory, "publish", "github-draft-pr.json");

  const verifyRemoteHead = async () => {
    const headOutput = await context.gitRunner.run(["ls-remote", "--heads", context.remoteName, `refs/heads/${context.headBranch}`], context.worktreePath);
    const headLines = headOutput.stdout.trim().split("\n").filter(Boolean);
    const firstHead = headLines[0];
    if (headLines.length !== 1 || !firstHead || !firstHead.startsWith(context.expectedHeadSha)) {
      throw new DraftPullRequestError("PR_REMOTE_BRANCH_MISMATCH", "Remote head branch does not exactly match the expected Phase 5A SHA.");
    }

    const baseOutput = await context.gitRunner.run(["ls-remote", "--heads", context.remoteName, `refs/heads/${context.baseBranch}`], context.worktreePath);
    const baseLines = baseOutput.stdout.trim().split("\n").filter(Boolean);
    if (baseLines.length !== 1) {
      throw new DraftPullRequestError("PR_BASE_BRANCH_MISSING", "Base branch is missing on the remote.");
    }
  };

  const persistReceipt = async (receipt: DraftPullRequestReceipt) => {
    await writeDraftPullRequestReceipt(storePath, receipt);
  };

  const machine = new DraftPullRequestStateMachine(context.client, persistReceipt, context.now);
  return machine.execute({
    runId: context.runId,
    taskId: context.taskId,
    owner: context.owner,
    repository: context.repository,
    baseBranch: context.baseBranch,
    headBranch: context.headBranch,
    expectedHeadSha: context.expectedHeadSha,
    changeSetSha256: context.changeSetSha256,
    gitPublishReceiptSha256: context.gitPublishReceiptSha256,
    existingReceipt: context.existingReceipt,
    verifyRemoteHead
  });
}

function canonicalDigestGitPublishReceipt(receipt: any): string {
  const explicit = JSON.stringify([
    "publish_version", receipt.publish_version,
    "run_id", receipt.run_id,
    "state", receipt.state,
    "base_commit", receipt.base_commit,
    "branch_name", receipt.branch_name,
    "remote_name", receipt.remote_name,
    "allowed_remote_url", receipt.allowed_remote_url,
    "change_set_sha256", receipt.change_set_sha256,
    "expected_paths", receipt.expected_paths,
    "approved_snapshot_sha256", receipt.approved_snapshot_sha256,
    "commit_sha", receipt.commit_sha,
    "remote_branch_sha", receipt.remote_branch_sha,
    "created_at", receipt.created_at,
    "updated_at", receipt.updated_at,
    "committed_at", receipt.committed_at,
    "pushed_at", receipt.pushed_at
  ]);
  return crypto.createHash("sha256").update(explicit, "utf8").digest("hex");
}

export async function createDraftPullRequestForRun(options: Phase5BDraftPrOptions): Promise<DraftPullRequestReceipt> {
  const stateDirectory = path.resolve(options.stateDirectory);
  const preparation = await readPreparationForExecution(stateDirectory, options.runId);
  const lock = await acquireExecutionLock(stateDirectory, preparation.archiveSha256);

  try {
    const execution = await readExecutionReceipt(stateDirectory, preparation.taskId, preparation.archiveSha256);
    if (!execution || execution.run_id !== options.runId) {
      throw new DraftPullRequestError("PR_PHASE5A_NOT_PUSHED", "Execution receipt missing or invalid run ID.");
    }

    await verifyBundleChecksums(preparation.receipt.accepted_bundle_path);
    const [bundleData, config] = await Promise.all([
      readBundleJson(preparation.receipt.accepted_bundle_path),
      loadPhase4Config(options.configPath)
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
      throw new DraftPullRequestError("PR_REQUEST_INVALID", "Contract validation failed.");
    }

    const p5aReceiptPath = path.join(stateDirectory, "publish", "git-publish.json");
    const p5aReceipt = await readGitPublishReceipt(p5aReceiptPath);
    if (!p5aReceipt) {
      throw new DraftPullRequestError("PR_PHASE5A_NOT_PUSHED", "Phase 5A receipt missing.");
    }
    if (
      p5aReceipt.state !== "PUSHED" ||
      p5aReceipt.run_id !== options.runId ||
      p5aReceipt.base_commit !== execution.base_commit ||
      p5aReceipt.branch_name !== execution.branch_name ||
      p5aReceipt.remote_name !== preparation.receipt.remote ||
      p5aReceipt.allowed_remote_url !== preparation.receipt.remote_url ||
      p5aReceipt.change_set_sha256 !== execution.change_set_sha256 ||
      p5aReceipt.commit_sha === null ||
      p5aReceipt.remote_branch_sha === null ||
      p5aReceipt.commit_sha !== p5aReceipt.remote_branch_sha
    ) {
      throw new DraftPullRequestError("PR_PHASE5A_NOT_PUSHED", "Phase 5A receipt indicates invalid state.");
    }

    const gitPublishReceiptSha256 = canonicalDigestGitPublishReceipt(p5aReceipt);
    const repoIdentity = parseGitHubRepositoryRemote(p5aReceipt.allowed_remote_url);

    if (!config.github_pull_request || config.github_pull_request.provider !== "github.com") {
      throw new DraftPullRequestError("PR_CONFIG_INVALID", "GitHub pull request config missing or invalid.");
    }
    if (!config.publish?.identity) {
      throw new DraftPullRequestError("PR_CONFIG_INVALID", "Publish config missing.");
    }

    const runtimeDirectory = path.join(stateDirectory, "git-runtime");
    const gitAuth = await preparePublishGitSecurity(config.publish, p5aReceipt.allowed_remote_url, runtimeDirectory, process.env);
    const gitRunner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth: gitAuth });

    const githubEnvKey = config.github_pull_request.authentication.token_environment_key;
    const githubToken = process.env[githubEnvKey];
    if (!githubToken) {
      throw new DraftPullRequestError("PR_AUTH_UNAVAILABLE", `Missing GitHub token at ${githubEnvKey}`);
    }

    const client = new GitHubRestPullRequestClient(githubToken);

    const storePath = path.join(stateDirectory, "publish", "github-draft-pr.json");
    const existingReceipt = await readDraftPullRequestReceipt(storePath);

    return await createPreparedDraftPullRequest({
      runId: options.runId,
      taskId: preparation.taskId,
      owner: repoIdentity.owner,
      repository: repoIdentity.repository,
      baseBranch: contract.delivery.base_branch,
      headBranch: p5aReceipt.branch_name,
      expectedHeadSha: p5aReceipt.remote_branch_sha,
      changeSetSha256: p5aReceipt.change_set_sha256,
      gitPublishReceiptSha256,
      client,
      existingReceipt,
      stateDirectory,
      gitRunner,
      worktreePath: execution.worktree_path,
      remoteName: p5aReceipt.remote_name,
      ...(options.now ? { now: options.now } : {})
    });

  } finally {
    await lock.release();
  }
}
