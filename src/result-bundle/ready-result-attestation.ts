import path from "node:path";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import { parseGitHubRepositoryRemote } from "../pull-request/github-remote.js";
import { ResultBundleError, type ResultBundleReceipt } from "./contracts.js";
import { attestGitHubPullRequest, type GitHubAttestationClient } from "./github-attestation.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; archiveSha: string } {
  const separator = runId.lastIndexOf(":");
  const taskId = runId.slice(0, separator);
  const archiveSha = runId.slice(separator + 1);
  if (separator <= 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !SHA256.test(archiveSha)) {
    throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid run ID for ready-result re-attestation.");
  }
  return { taskId, archiveSha };
}

function containedAuthorityPath(stateDirectory: string, candidate: string, label: string): string {
  const root = path.resolve(stateDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${label} escapes the trusted state directory.`);
  }
  return resolved;
}

function exactAttestationMatches(left: ResultBundleReceipt["pull_request"], right: ResultBundleReceipt["pull_request"]): boolean {
  return left.number === right.number
    && left.url === right.url
    && left.state === right.state
    && left.draft === right.draft
    && left.head_branch === right.head_branch
    && left.head_sha === right.head_sha
    && left.base_branch === right.base_branch
    && left.title_sha256 === right.title_sha256;
}

export async function reattestReadyResultBundleAuthority(options: {
  stateDirectory: string;
  runId: string;
  receipt: ResultBundleReceipt;
  githubClient: GitHubAttestationClient;
  publishReceiptPath?: string;
  draftReceiptPath?: string;
}): Promise<void> {
  const { taskId, archiveSha } = splitRunId(options.runId);
  const root = path.resolve(options.stateDirectory);
  const p5aPath = containedAuthorityPath(
    root,
    options.publishReceiptPath ?? path.join(root, "runs", taskId, archiveSha, "execution", "publish", "git-publish.json"),
    "Ready Result Bundle publish receipt path",
  );
  const p5bPath = containedAuthorityPath(
    root,
    options.draftReceiptPath ?? path.join(root, "publish", "github-draft-pr.json"),
    "Ready Result Bundle Draft PR receipt path",
  );
  const p5a = await readGitPublishReceipt(p5aPath);
  const p5b = await readDraftPullRequestReceipt(p5bPath);

  if (!p5a || p5a.state !== "PUSHED" || p5a.run_id !== options.runId || !p5a.commit_sha || p5a.remote_branch_sha !== p5a.commit_sha) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INCONSISTENT", "Ready Result Bundle no longer has an exact PUSHED publish authority.");
  }
  if (!p5b || p5b.state !== "OPEN" || p5b.run_id !== options.runId || p5b.pull_number === null || p5b.expected_head_sha !== p5a.commit_sha) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", "Ready Result Bundle no longer has an exact open Draft PR receipt authority.");
  }
  if (
    options.receipt.run_id !== options.runId
    || options.receipt.state !== "READY_FOR_WEB_REVIEW"
    || options.receipt.published_commit_sha !== p5a.commit_sha
    || options.receipt.remote_branch_sha !== p5a.commit_sha
    || options.receipt.pull_request.number !== p5b.pull_number
    || options.receipt.pull_request.head_sha !== p5a.commit_sha
  ) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Ready Result Bundle receipt no longer matches persisted publication authority.");
  }

  let identity;
  try {
    identity = parseGitHubRepositoryRemote(p5a.allowed_remote_url);
  } catch (error) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", `Cannot validate ready Result Bundle repository identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (p5b.repository_owner !== identity.owner || p5b.repository_name !== identity.repository) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", "Ready Result Bundle repository identity differs between publish and Draft PR receipts.");
  }

  const fresh = await attestGitHubPullRequest(
    options.githubClient,
    identity.owner,
    identity.repository,
    p5b.pull_number,
    {
      headBranch: p5a.branch_name,
      headSha: p5a.commit_sha,
      baseBranch: p5b.base_branch,
    },
  );

  if (!exactAttestationMatches(options.receipt.pull_request, fresh)) {
    throw new ResultBundleError("RESULT_PR_IDENTITY_MISMATCH", "Ready Result Bundle PR authority changed after the handoff was sealed.");
  }
}
