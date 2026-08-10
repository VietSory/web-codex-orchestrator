import { unlink } from "node:fs/promises";
import path from "node:path";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity, type PreparedPublishGitSecurity } from "../publish/publish-auth.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { canonicalGitPublishReceiptDigest } from "../publish/receipt-digest.js";
import { parseGitHubRepositoryRemote } from "../pull-request/github-remote.js";
import { GitHubRestPullRequestClient } from "../pull-request/github-rest-client.js";
import { createPreparedDraftPullRequest } from "../pull-request/phase5b-service.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import type { DraftPullRequestReceipt } from "../pull-request/contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { OrchestrationError } from "./contracts.js";
import { resolveGitHubToken } from "../setup/credential-provider.js";

async function cleanupPublishAuth(auth: PreparedPublishGitSecurity): Promise<void> {
  if (auth.mode !== "https_token") return;
  await unlink(auth.askpassScriptPath).catch(() => undefined);
}

export async function openDraftPullRequestForExecutorSnapshot(options: {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<DraftPullRequestReceipt> {
  const ready = await attestReadyExecutorSnapshot(options);
  const run = ready.source.trusted.runReceipt;
  const publishPath = path.join(ready.executorDirectory, "publish", "git-publish.json");
  const publish = await readGitPublishReceipt(publishPath);
  if (
    !publish || publish.state !== "PUSHED" || publish.run_id !== options.runId ||
    publish.base_commit !== run.base_commit || publish.branch_name !== run.branch_name ||
    publish.remote_name !== run.remote || publish.allowed_remote_url !== run.remote_url ||
    publish.change_set_sha256 !== ready.changeSetDigest || publish.commit_sha === null ||
    publish.remote_branch_sha === null || publish.commit_sha !== publish.remote_branch_sha
  ) {
    throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_AUTHORITY_DRIFT", "Draft PR creation requires the exact attested PUSHED Phase 10 snapshot.");
  }

  const config = await loadPhase4Config(options.configPath);
  if (!config.github_pull_request || config.github_pull_request.provider !== "github.com" || !config.publish?.identity) {
    throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_CONFIG_INVALID", "Trusted GitHub Draft PR and publish identity configuration are required.");
  }
  let token: string;
  try {
    token = await resolveGitHubToken(config.github_pull_request.authentication);
  } catch {
    throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_AUTH_UNAVAILABLE", "GitHub credentials are unavailable.");
  }

  const repo = parseGitHubRepositoryRemote(publish.allowed_remote_url);
  const runtimeDirectory = path.join(ready.executorDirectory, "publish", "git-runtime");
  const auth = await preparePublishGitSecurity(config.publish, publish.allowed_remote_url, runtimeDirectory, process.env);
  try {
    const gitRunner = new GitRunner(process.env, runtimeDirectory, {
      identity: config.publish.identity,
      auth,
      allowedRemoteUrl: publish.allowed_remote_url,
    });
    const client = new GitHubRestPullRequestClient(token);
    const receiptPath = path.join(ready.executorDirectory, "publish", "github-draft-pr.json");
    const existingReceipt = await readDraftPullRequestReceipt(receiptPath);
    const receipt = await createPreparedDraftPullRequest({
      runId: options.runId,
      taskId: run.task_id,
      owner: repo.owner,
      repository: repo.repository,
      baseBranch: run.base_branch,
      headBranch: publish.branch_name,
      expectedHeadSha: publish.remote_branch_sha,
      changeSetSha256: ready.changeSetDigest,
      gitPublishReceiptSha256: canonicalGitPublishReceiptDigest(publish),
      client,
      existingReceipt,
      stateDirectory: ready.executorDirectory,
      gitRunner,
      worktreePath: run.worktree_path,
      remoteUrl: publish.allowed_remote_url,
      ...(options.now ? { now: options.now } : {}),
    });
    if (
      receipt.state !== "OPEN" || receipt.observed_draft !== true ||
      receipt.observed_state !== "open" || receipt.observed_head_sha !== publish.remote_branch_sha ||
      receipt.expected_head_sha !== publish.remote_branch_sha
    ) {
      throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_INCOMPLETE", "Draft PR operation did not end at the exact open Draft PR head.");
    }
    return receipt;
  } finally {
    await cleanupPublishAuth(auth);
  }
}
