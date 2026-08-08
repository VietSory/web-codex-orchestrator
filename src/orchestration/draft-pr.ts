import { unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity, type PreparedPublishGitSecurity } from "../publish/publish-auth.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { parseGitHubRepositoryRemote } from "../pull-request/github-remote.js";
import { GitHubRestPullRequestClient } from "../pull-request/github-rest-client.js";
import { createPreparedDraftPullRequest } from "../pull-request/phase5b-service.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import { DraftPullRequestError, type DraftPullRequestReceipt } from "../pull-request/contracts.js";
import { createBoundedFetch } from "../runtime/fetch-bounded.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { OrchestrationError } from "./contracts.js";

const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

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
    "pushed_at", receipt.pushed_at,
  ]);
  return crypto.createHash("sha256").update(explicit, "utf8").digest("hex");
}

async function cleanupPublishAuth(auth: PreparedPublishGitSecurity): Promise<void> {
  if (auth.mode !== "https_token") return;
  await unlink(auth.askpassScriptPath).catch(() => undefined);
}

function mapGitHubTimeout(error: unknown): never {
  if (error instanceof DraftPullRequestError && /deadline|timed? out|abort/i.test(error.message)) {
    throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_TIMEOUT", `Bounded GitHub Draft PR request timed out: ${error.message}`);
  }
  throw error;
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
  const tokenKey = config.github_pull_request.authentication.token_environment_key;
  const token = process.env[tokenKey];
  if (!token) throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_AUTH_UNAVAILABLE", `Missing GitHub token at ${tokenKey}.`);

  const repo = parseGitHubRepositoryRemote(publish.allowed_remote_url);
  const runtimeDirectory = path.join(ready.executorDirectory, "publish", "git-runtime");
  const auth = await preparePublishGitSecurity(config.publish, publish.allowed_remote_url, runtimeDirectory, process.env);
  try {
    const gitRunner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth });
    const client = new GitHubRestPullRequestClient(token, createBoundedFetch({ timeoutMs: GITHUB_REQUEST_TIMEOUT_MS }));
    const receiptPath = path.join(ready.executorDirectory, "publish", "github-draft-pr.json");
    const existingReceipt = await readDraftPullRequestReceipt(receiptPath);
    try {
      const receipt = await createPreparedDraftPullRequest({
        runId: options.runId,
        taskId: run.task_id,
        owner: repo.owner,
        repository: repo.repository,
        baseBranch: run.base_branch,
        headBranch: publish.branch_name,
        expectedHeadSha: publish.remote_branch_sha,
        changeSetSha256: ready.changeSetDigest,
        gitPublishReceiptSha256: canonicalDigestGitPublishReceipt(publish),
        client,
        existingReceipt,
        stateDirectory: ready.executorDirectory,
        gitRunner,
        worktreePath: run.worktree_path,
        remoteName: publish.remote_name,
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
    } catch (error) {
      mapGitHubTimeout(error);
    }
  } finally {
    await cleanupPublishAuth(auth);
  }
}
