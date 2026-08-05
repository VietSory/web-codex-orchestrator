// Read-only GitHub PR attestation for Phase 6
// Only uses GET /repos/{owner}/{repo}/pulls/{pull_number}
// No POST, PATCH, PUT, DELETE, comments, labels, merge, or state mutation.
import { ResultBundleError } from "./contracts.js";
import type { PullRequestAttestation } from "./contracts.js";
import crypto from "node:crypto";

export interface GitHubAttestationClient {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<unknown>;
}

interface PullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

function assertPrResponse(value: unknown): asserts value is PullRequestResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "PR response is not an object.");
  }
  const obj = value as Record<string, unknown>;
  const requiredStrings = ["html_url", "state", "title"] as const;
  for (const field of requiredStrings) {
    if (typeof obj[field] !== "string") {
      throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", `PR response missing string field: ${field}`);
    }
  }
  if (typeof obj.number !== "number") {
    throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "PR response missing numeric 'number'.");
  }
  if (typeof obj.draft !== "boolean" || typeof obj.merged !== "boolean") {
    throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "PR response missing boolean fields.");
  }
  const head = obj.head as Record<string, unknown>;
  const base = obj.base as Record<string, unknown>;
  if (!head || typeof head.ref !== "string" || typeof head.sha !== "string") {
    throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "PR response missing head.ref or head.sha.");
  }
  if (!base || typeof base.ref !== "string") {
    throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "PR response missing base.ref.");
  }
}

/**
 * Performs read-only attestation of a GitHub PR and returns the public snapshot.
 * Validates identity against expected values.
 */
export async function attestGitHubPullRequest(
  client: GitHubAttestationClient,
  owner: string,
  repo: string,
  prNumber: number,
  expected: {
    headBranch: string;
    headSha: string;
    baseBranch: string;
  }
): Promise<PullRequestAttestation> {
  let raw: unknown;
  try {
    raw = await client.getPullRequest(owner, repo, prNumber);
  } catch (error) {
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError(
      "RESULT_PR_API_FAILED",
      `GitHub PR attestation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  assertPrResponse(raw);

  // Validate not merged
  if (raw.merged || raw.merged_at !== null) {
    throw new ResultBundleError("RESULT_PR_MERGED", `PR #${prNumber} is merged.`);
  }

  // Validate open state
  if (raw.state !== "open") {
    throw new ResultBundleError("RESULT_PR_NOT_OPEN", `PR #${prNumber} state is '${raw.state}', expected 'open'.`);
  }

  // Validate identity
  if (raw.head.ref !== expected.headBranch) {
    throw new ResultBundleError(
      "RESULT_PR_IDENTITY_MISMATCH",
      `PR head branch is '${raw.head.ref}', expected '${expected.headBranch}'.`
    );
  }
  if (raw.head.sha !== expected.headSha) {
    throw new ResultBundleError(
      "RESULT_PR_IDENTITY_MISMATCH",
      `PR head SHA is '${raw.head.sha}', expected '${expected.headSha}'.`
    );
  }
  if (raw.base.ref !== expected.baseBranch) {
    throw new ResultBundleError(
      "RESULT_PR_IDENTITY_MISMATCH",
      `PR base branch is '${raw.base.ref}', expected '${expected.baseBranch}'.`
    );
  }

  return {
    number: raw.number,
    url: raw.html_url,
    state: "open",
    draft: raw.draft,
    head_branch: raw.head.ref,
    head_sha: raw.head.sha,
    base_branch: raw.base.ref,
    title_sha256: crypto.createHash("sha256").update(raw.title, "utf8").digest("hex"),
  };
}

/** Production GitHub REST client for PR attestation */
export class GitHubRestAttestationClient implements GitHubAttestationClient {
  constructor(
    private readonly token: string,
    private readonly maxResponseBytes: number = 1_048_576
  ) {}

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<unknown> {
    const baseUrl = process.env.GITHUB_API_URL || "https://api.github.com";
    const url = `${baseUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "web-codex-orchestrator/phase6",
        },
        redirect: "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("redirect")) {
        throw new ResultBundleError("RESULT_PR_API_REDIRECT_REJECTED", "GitHub response attempted an untrusted redirect.");
      }
      throw new ResultBundleError("RESULT_PR_API_FAILED", `Network error: ${message}`);
    }

    if (response.status === 401) throw new ResultBundleError("RESULT_PR_API_UNAUTHORIZED", "GitHub returned 401 Unauthorized.");
    if (response.status === 403) throw new ResultBundleError("RESULT_PR_API_FORBIDDEN", "GitHub returned 403 Forbidden.");
    if (response.status === 404) throw new ResultBundleError("RESULT_PR_API_NOT_FOUND", `PR not found: ${owner}/${repo}#${prNumber}`);
    if (response.status === 429 || (response.status >= 400 && response.headers.get("x-ratelimit-remaining") === "0")) {
      throw new ResultBundleError("RESULT_PR_API_RATE_LIMITED", "GitHub rate limit exceeded.");
    }
    if (!response.ok) {
      throw new ResultBundleError("RESULT_PR_API_FAILED", `GitHub returned ${response.status}.`);
    }

    // Read bounded response
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > this.maxResponseBytes) {
      throw new ResultBundleError("RESULT_PR_API_RESPONSE_TOO_LARGE", `GitHub response too large: ${contentLength} bytes.`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxResponseBytes) {
      throw new ResultBundleError("RESULT_PR_API_RESPONSE_TOO_LARGE", `GitHub response too large: ${buffer.byteLength} bytes.`);
    }

    try {
      return JSON.parse(Buffer.from(buffer).toString("utf8")) as unknown;
    } catch {
      throw new ResultBundleError("RESULT_PR_API_RESPONSE_INVALID", "GitHub response is not valid JSON.");
    }
  }
}
