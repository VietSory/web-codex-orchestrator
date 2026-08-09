import crypto from "node:crypto";
import path from "node:path";
import { readGitPublishReceiptSnapshot } from "../publish/publish-store.js";
import { canonicalGitPublishReceiptDigest } from "../publish/receipt-digest.js";
import { readDraftPullRequestReceiptSnapshot } from "../pull-request/draft-pr-store.js";
import { parseGitHubRepositoryRemote } from "../pull-request/github-remote.js";
import { ResultBundleError, type ResultBundleReceipt } from "./contracts.js";
import { attestGitHubPullRequest, type GitHubAttestationClient } from "./github-attestation.js";

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

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
  const [p5aSnapshot, p5bSnapshot] = await Promise.all([
    readGitPublishReceiptSnapshot(p5aPath),
    readDraftPullRequestReceiptSnapshot(p5bPath),
  ]);
  const p5a = p5aSnapshot?.receipt ?? null;
  const p5b = p5bSnapshot?.receipt ?? null;

  if (!p5aSnapshot || !p5a || p5a.state !== "PUSHED" || p5a.run_id !== options.runId || !p5a.commit_sha || p5a.remote_branch_sha !== p5a.commit_sha) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INCONSISTENT", "Ready Result Bundle no longer has an exact PUSHED publish authority.");
  }
  if (
    !p5bSnapshot || !p5b || p5b.state !== "OPEN" || p5b.run_id !== options.runId ||
    p5b.pull_number === null || p5b.expected_head_sha !== p5a.commit_sha ||
    p5b.git_publish_receipt_sha256 !== canonicalGitPublishReceiptDigest(p5a)
  ) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", "Ready Result Bundle no longer has an exact Draft PR receipt bound to the current publish authority.");
  }
  if (
    options.receipt.run_id !== options.runId
    || options.receipt.state !== "READY_FOR_WEB_REVIEW"
    || options.receipt.git_publish_receipt_sha256 !== sha256(p5aSnapshot.bytes)
    || options.receipt.draft_pr_receipt_sha256 !== sha256(p5bSnapshot.bytes)
    || options.receipt.published_commit_sha !== p5a.commit_sha
    || options.receipt.remote_branch_sha !== p5a.commit_sha
    || options.receipt.pull_request.number !== p5b.pull_number
    || options.receipt.pull_request.head_sha !== p5a.commit_sha
  ) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Ready Result Bundle receipt no longer matches the exact persisted publication authority.");
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
    { headBranch: p5a.branch_name, headSha: p5a.commit_sha, baseBranch: p5b.base_branch },
  );
  if (!exactAttestationMatches(options.receipt.pull_request, fresh)) {
    throw new ResultBundleError("RESULT_PR_IDENTITY_MISMATCH", "Ready Result Bundle PR authority changed after the handoff was sealed.");
  }
}
