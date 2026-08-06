import { WebReviewError, type WebReviewVerdict } from "./contracts.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import type { TrustedConfig } from "../config/contracts.js";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";

export interface VerifiedGitHubAttestation {
  prNumber: number;
  htmlUrl: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
}

const PINNED_GITHUB_API_URL = "https://api.github.com";

/**
 * Strict GitHub attestation validator (P0-05).
 * Enforces mandatory fresh GitHub API PR status verification against exact Phase 6 receipt and verdict.
 * Production requests MUST pin endpoint to https://api.github.com (no arbitrary GITHUB_API_URL redirect).
 */
export async function verifyGitHubAttestation(params: {
  receipt: ResultBundleReceipt;
  config: TrustedConfig;
  verdict: WebReviewVerdict;
  githubClient?: GitHubAttestationClient | undefined;
}): Promise<VerifiedGitHubAttestation> {
  const { receipt, config, verdict, githubClient } = params;

  // Verify PR URL format
  if (!receipt.pull_request || !receipt.pull_request.url) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "Phase 6 receipt missing pull_request.url");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(receipt.pull_request.url);
  } catch {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Invalid PR URL format '${receipt.pull_request.url}'`
    );
  }

  if (parsedUrl.protocol !== "https:") {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "PR URL must use HTTPS protocol");
  }
  if (parsedUrl.hostname !== "github.com") {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `PR URL host '${parsedUrl.hostname}' is not github.com`);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "PR URL contains credentials, query or fragment");
  }

  const urlPathParts = parsedUrl.pathname.split("/").filter(Boolean);
  if (urlPathParts.length !== 4 || urlPathParts[2] !== "pull") {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `PR URL pathname '${parsedUrl.pathname}' does not match '/<owner>/<repo>/pull/<number>'`
    );
  }

  const owner = urlPathParts[0]!;
  const repo = urlPathParts[1]!;
  const prNumStr = urlPathParts[3]!;

  const prNumber = parseInt(prNumStr, 10);
  if (isNaN(prNumber) || prNumber <= 0 || prNumber !== receipt.pull_request.number) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `PR number '${prNumStr}' in URL does not match receipt pull_request.number '${receipt.pull_request.number}'`
    );
  }

  let prData: any;

  if (githubClient) {
    // Tests or custom injected client
    try {
      prData = await githubClient.getPullRequest(owner, repo, prNumber);
    } catch (e) {
      throw new WebReviewError(
        "WEB_REVIEW_AUTH_ERROR",
        `GitHub attestation request failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    // Real production call
    const tokenEnvKey = config.github_pull_request?.authentication?.token_environment_key ?? "WCO_GITHUB_TOKEN";
    const token = process.env[tokenEnvKey];
    if (!token) {
      throw new WebReviewError(
        "WEB_REVIEW_AUTH_ERROR",
        `Mandatory GitHub attestation failed: environment variable '${tokenEnvKey}' is not set`
      );
    }

    // Require pinned endpoint for production token call (P0-05, P7R2-T-011)
    const apiEndpoint = PINNED_GITHUB_API_URL;
    const apiUrl = `${apiEndpoint}/repos/${owner}/${repo}/pulls/${prNumber}`;

    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "wco-phase7-attestation",
        },
      });

      if (!response.ok) {
        throw new WebReviewError(
          "WEB_REVIEW_AUTH_ERROR",
          `GitHub API attestation returned HTTP ${response.status}: ${response.statusText}`
        );
      }

      prData = await response.json();
    } catch (e) {
      if (e instanceof WebReviewError) throw e;
      throw new WebReviewError(
        "WEB_REVIEW_AUTH_ERROR",
        `GitHub API attestation network error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  if (!prData || typeof prData !== "object") {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub API response is not an object");
  }

  // Strict assertions on PR payload
  if (prData.number !== prNumber) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `Attestation PR number ${prData.number} does not match expected ${prNumber}`
    );
  }

  if (prData.state !== "open") {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR state is '${prData.state}', expected 'open'`
    );
  }

  if (prData.merged === true) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      "GitHub PR has already been merged"
    );
  }

  const expectedRepoFullName = `${owner}/${repo}`.toLowerCase();
  const headRepoFullName = prData.head?.repo?.full_name?.toLowerCase();
  const baseRepoFullName = prData.base?.repo?.full_name?.toLowerCase();

  if (headRepoFullName && headRepoFullName !== expectedRepoFullName) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR head repository '${headRepoFullName}' does not match expected '${expectedRepoFullName}'`
    );
  }

  if (baseRepoFullName && baseRepoFullName !== expectedRepoFullName) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR base repository '${baseRepoFullName}' does not match expected '${expectedRepoFullName}'`
    );
  }

  const headBranch = prData.head?.ref;
  if (!headBranch || headBranch !== receipt.pull_request.head_branch) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR head branch '${headBranch}' does not match Phase 6 receipt head branch '${receipt.pull_request.head_branch}'`
    );
  }

  const baseBranch = prData.base?.ref;
  if (!baseBranch || baseBranch !== receipt.pull_request.base_branch) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR base branch '${baseBranch}' does not match Phase 6 receipt base branch '${receipt.pull_request.base_branch}'`
    );
  }

  const headSha = prData.head?.sha;
  if (!headSha || headSha !== verdict.observed_head_sha || headSha !== receipt.published_commit_sha) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR head SHA '${headSha}' mismatch with verdict observed_head_sha '${verdict.observed_head_sha}' or Phase 6 published_commit_sha '${receipt.published_commit_sha}'`
    );
  }

  const baseSha = prData.base?.sha;
  if (baseSha && receipt.base_commit && baseSha !== receipt.base_commit) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR base SHA '${baseSha}' does not match Phase 6 receipt base_commit '${receipt.base_commit}'`
    );
  }

  return {
    prNumber,
    htmlUrl: prData.html_url ?? receipt.pull_request.url,
    headRepoFullName: headRepoFullName ?? expectedRepoFullName,
    baseRepoFullName: baseRepoFullName ?? expectedRepoFullName,
    headBranch,
    baseBranch,
    headSha,
    baseSha: baseSha ?? receipt.base_commit,
  };
}
