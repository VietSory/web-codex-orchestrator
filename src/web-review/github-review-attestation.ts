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
  draft: true;
}

const PINNED_GITHUB_API_URL = "https://api.github.com";
export const MAX_GITHUB_ATTESTATION_RESPONSE_BYTES = 1024 * 1024;
export const GITHUB_ATTESTATION_TIMEOUT_MS = 10_000;

async function readBoundedResponseBody(response: Response): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_GITHUB_ATTESTATION_RESPONSE_BYTES) {
      throw new WebReviewError(
        "WEB_REVIEW_REPOSITORY_DRIFT",
        `GitHub attestation response declared unsafe size '${contentLengthHeader}'`
      );
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_GITHUB_ATTESTATION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebReviewError(
          "WEB_REVIEW_REPOSITORY_DRIFT",
          `GitHub attestation response exceeds ${MAX_GITHUB_ATTESTATION_RESPONSE_BYTES} bytes`
        );
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Strict read-only GitHub attestation validator.
 * Production is pinned to api.github.com and every identity field used for a
 * merge decision is mandatory; missing fields are repository drift, never a
 * reason to fall back to trusted local expectations.
 */
export async function verifyGitHubAttestation(params: {
  receipt: ResultBundleReceipt;
  config: TrustedConfig;
  verdict: WebReviewVerdict;
  githubClient?: GitHubAttestationClient | undefined;
}): Promise<VerifiedGitHubAttestation> {
  const { receipt, config, verdict, githubClient } = params;

  if (!receipt.pull_request || !receipt.pull_request.url) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "Phase 6 receipt missing pull_request.url");
  }
  if (receipt.pull_request.draft !== true) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "Phase 6 receipt does not attest an open Draft Pull Request");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(receipt.pull_request.url);
  } catch {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `Invalid PR URL format '${receipt.pull_request.url}'`);
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
  const prNumber = Number(prNumStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || prNumber !== receipt.pull_request.number) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `PR number '${prNumStr}' in URL does not match receipt pull_request.number '${receipt.pull_request.number}'`
    );
  }

  let prData: any;
  if (githubClient) {
    try {
      prData = await githubClient.getPullRequest(owner, repo, prNumber);
    } catch (e) {
      if (e instanceof WebReviewError) throw e;
      throw new WebReviewError(
        "WEB_REVIEW_AUTH_ERROR",
        `GitHub attestation request failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    const tokenEnvKey = config.github_pull_request?.authentication?.token_environment_key ?? "WCO_GITHUB_TOKEN";
    const token = process.env[tokenEnvKey];
    if (!token) {
      throw new WebReviewError(
        "WEB_REVIEW_AUTH_ERROR",
        `Mandatory GitHub attestation failed: environment variable '${tokenEnvKey}' is not set`
      );
    }

    const apiUrl = `${PINNED_GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wco-phase7-attestation",
        },
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_ATTESTATION_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebReviewError(
          "WEB_REVIEW_AUTH_ERROR",
          `GitHub API attestation returned HTTP ${response.status}: ${response.statusText}`
        );
      }

      const responseBytes = await readBoundedResponseBody(response);
      try {
        prData = JSON.parse(responseBytes.toString("utf8"));
      } catch {
        throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub attestation response is not valid JSON");
      }
    } catch (e) {
      if (e instanceof WebReviewError) throw e;
      throw new WebReviewError(
        "WEB_REVIEW_NETWORK_ERROR",
        `GitHub API attestation network error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  if (!prData || typeof prData !== "object" || Array.isArray(prData)) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub API response is not an object");
  }
  if (prData.number !== prNumber) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `Attestation PR number ${prData.number} does not match expected ${prNumber}`);
  }
  if (prData.state !== "open") {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR state is '${prData.state}', expected 'open'`);
  }
  if (prData.merged !== false) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub PR merged state is missing, invalid, or already merged");
  }
  if (prData.draft !== true) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub PR is no longer in Draft state");
  }

  const expectedRepoFullName = `${owner}/${repo}`.toLowerCase();
  const rawHeadRepoFullName = prData.head?.repo?.full_name;
  const rawBaseRepoFullName = prData.base?.repo?.full_name;
  if (typeof rawHeadRepoFullName !== "string" || rawHeadRepoFullName.length === 0) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub PR response is missing head.repo.full_name");
  }
  if (typeof rawBaseRepoFullName !== "string" || rawBaseRepoFullName.length === 0) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub PR response is missing base.repo.full_name");
  }
  const headRepoFullName = rawHeadRepoFullName.toLowerCase();
  const baseRepoFullName = rawBaseRepoFullName.toLowerCase();
  if (headRepoFullName !== expectedRepoFullName) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR head repository '${headRepoFullName}' does not match expected '${expectedRepoFullName}'`);
  }
  if (baseRepoFullName !== expectedRepoFullName) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR base repository '${baseRepoFullName}' does not match expected '${expectedRepoFullName}'`);
  }

  const headBranch = prData.head?.ref;
  if (typeof headBranch !== "string" || headBranch !== receipt.pull_request.head_branch) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR head branch '${headBranch}' does not match Phase 6 receipt head branch '${receipt.pull_request.head_branch}'`);
  }
  const baseBranch = prData.base?.ref;
  if (typeof baseBranch !== "string" || baseBranch !== receipt.pull_request.base_branch) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR base branch '${baseBranch}' does not match Phase 6 receipt base branch '${receipt.pull_request.base_branch}'`);
  }

  const headSha = prData.head?.sha;
  if (typeof headSha !== "string" || headSha !== verdict.observed_head_sha || headSha !== receipt.published_commit_sha || headSha !== receipt.pull_request.head_sha) {
    throw new WebReviewError(
      "WEB_REVIEW_REPOSITORY_DRIFT",
      `GitHub PR head SHA '${headSha}' mismatch with verdict/Phase 6 bindings`
    );
  }
  const baseSha = prData.base?.sha;
  if (typeof baseSha !== "string" || baseSha.length === 0) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", "GitHub PR response is missing base.sha");
  }
  if (baseSha !== receipt.base_commit) {
    throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `GitHub PR base SHA '${baseSha}' does not match Phase 6 receipt base_commit '${receipt.base_commit}'`);
  }

  return {
    prNumber,
    htmlUrl: typeof prData.html_url === "string" && prData.html_url.length > 0 ? prData.html_url : receipt.pull_request.url,
    headRepoFullName,
    baseRepoFullName,
    headBranch,
    baseBranch,
    headSha,
    baseSha,
    draft: true,
  };
}
