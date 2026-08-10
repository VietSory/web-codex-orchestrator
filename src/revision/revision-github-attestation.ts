import type { TrustedConfig } from "../config/contracts.js";
import { resolveGitHubToken } from "../setup/credential-provider.js";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";
import { RevisionError } from "./contracts.js";

export interface RevisionGitHubExpected {
  pullRequestUrl: string;
  pullRequestNumber: number;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
}

export interface RevisionGitHubAttestation {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  htmlUrl: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  draft: true;
}

const PINNED_GITHUB_API_URL = "https://api.github.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

async function readBoundedBody(response: Response): Promise<Buffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new RevisionError("REVISION_PR_DRIFT", `GitHub response declared unsafe content length '${lengthHeader}'.`);
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
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RevisionError("REVISION_PR_DRIFT", `GitHub response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function parsePrUrl(value: string, expectedNumber: number): { owner: string; repo: string } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RevisionError("REVISION_PR_DRIFT", `Invalid Pull Request URL '${value}'.`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RevisionError("REVISION_PR_DRIFT", "Pull Request URL is not a canonical HTTPS github.com URL.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || Number(parts[3]) !== expectedNumber) {
    throw new RevisionError("REVISION_PR_DRIFT", "Pull Request URL identity does not match the sealed PR number.");
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function httpFailure(status: number): RevisionError {
  if (status === 401 || status === 403) return new RevisionError("REVISION_CONFIG_INVALID", `GitHub attestation authorization failed with HTTP ${status}.`);
  if (status === 404 || status === 410 || status === 422) return new RevisionError("REVISION_PR_DRIFT", `GitHub Pull Request identity is unavailable or stale (HTTP ${status}).`);
  return new RevisionError("REVISION_OPERATIONAL_ERROR", `GitHub attestation failed with HTTP ${status}.`);
}

export async function attestRevisionPullRequest(params: {
  expected: RevisionGitHubExpected;
  config: TrustedConfig;
  githubClient?: GitHubAttestationClient | undefined;
}): Promise<RevisionGitHubAttestation> {
  const { expected, config, githubClient } = params;
  const { owner, repo } = parsePrUrl(expected.pullRequestUrl, expected.pullRequestNumber);
  let raw: any;

  if (githubClient) {
    try { raw = await githubClient.getPullRequest(owner, repo, expected.pullRequestNumber); }
    catch (error) { throw error instanceof RevisionError ? error : new RevisionError("REVISION_OPERATIONAL_ERROR", `Injected GitHub attestation client failed: ${error instanceof Error ? error.message : String(error)}`); }
  } else {
    const authentication = config.github_pull_request?.authentication;
    if (!authentication) throw new RevisionError("REVISION_CONFIG_INVALID", "GitHub authentication is not configured.");
    let token: string;
    try {
      token = await resolveGitHubToken(authentication);
    } catch {
      throw new RevisionError("REVISION_CONFIG_INVALID", "GitHub credentials are unavailable.");
    }
    const url = `${PINNED_GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${expected.pullRequestNumber}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wco-phase8-attestation",
        },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new RevisionError("REVISION_OPERATIONAL_ERROR", `GitHub attestation transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw httpFailure(response.status);
    const bytes = await readBoundedBody(response);
    try { raw = JSON.parse(bytes.toString("utf8")); }
    catch { throw new RevisionError("REVISION_PR_DRIFT", "GitHub attestation response is not valid JSON."); }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RevisionError("REVISION_PR_DRIFT", "GitHub Pull Request response is not an object.");
  if (raw.number !== expected.pullRequestNumber) throw new RevisionError("REVISION_PR_DRIFT", "GitHub Pull Request number drifted.");
  if (raw.state !== "open" || raw.merged !== false || raw.draft !== true) throw new RevisionError("REVISION_PR_DRIFT", "Pull Request must remain open, unmerged and Draft throughout Phase 8.");

  const expectedRepo = `${owner}/${repo}`.toLowerCase();
  const headRepo = raw.head?.repo?.full_name;
  const baseRepo = raw.base?.repo?.full_name;
  if (typeof headRepo !== "string" || headRepo.toLowerCase() !== expectedRepo || typeof baseRepo !== "string" || baseRepo.toLowerCase() !== expectedRepo) {
    throw new RevisionError("REVISION_PR_DRIFT", "Pull Request repository identity drifted.");
  }
  const headBranch = raw.head?.ref;
  const headSha = raw.head?.sha;
  const baseBranch = raw.base?.ref;
  const baseSha = raw.base?.sha;
  if (headBranch !== expected.headBranch) throw new RevisionError("REVISION_BRANCH_DRIFT", `PR head branch '${String(headBranch)}' does not match '${expected.headBranch}'.`);
  if (headSha !== expected.headSha) throw new RevisionError("REVISION_HEAD_DRIFT", `PR head SHA '${String(headSha)}' does not match '${expected.headSha}'.`);
  if (baseBranch !== expected.baseBranch) throw new RevisionError("REVISION_PR_DRIFT", `PR base branch '${String(baseBranch)}' does not match '${expected.baseBranch}'.`);
  if (baseSha !== expected.baseSha) throw new RevisionError("REVISION_PR_DRIFT", `PR base SHA '${String(baseSha)}' does not match '${expected.baseSha}'.`);

  return {
    owner,
    repo,
    pullRequestNumber: expected.pullRequestNumber,
    htmlUrl: typeof raw.html_url === "string" && raw.html_url.length > 0 ? raw.html_url : expected.pullRequestUrl,
    headBranch,
    headSha,
    baseBranch,
    baseSha,
    draft: true,
  };
}
