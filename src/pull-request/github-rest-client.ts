import { DraftPullRequestError, GitHubPullRequest, GitHubPullRequestClient } from "./contracts.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_ERROR_DIAGNOSTIC_BYTES = 8_192;
const MAXIMUM_SERVER_RETRY_HINT_MS = 24 * 60 * 60 * 1000;

export function parseGitHubRetryAfterMs(headers: Headers, nowMs = Date.now()): number | null {
  const candidates: number[] = [];
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
      const seconds = Number(retryAfter);
      if (Number.isSafeInteger(seconds) && seconds > 0) candidates.push(seconds * 1000);
    } else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at) && at > nowMs) candidates.push(at - nowMs);
    }
  }

  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const epochSeconds = Number(reset);
    if (Number.isSafeInteger(epochSeconds)) {
      const delay = epochSeconds * 1000 - nowMs;
      if (delay > 0) candidates.push(delay);
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(MAXIMUM_SERVER_RETRY_HINT_MS, Math.max(...candidates));
}

export class GitHubRestPullRequestClient implements GitHubPullRequestClient {
  private readonly token: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(token: string, fetchImplementation: typeof fetch = globalThis.fetch) {
    if (typeof token !== "string") throw new DraftPullRequestError("PR_AUTH_UNAVAILABLE", "Token is missing.");
    if (token.length < 1 || token.length > 4096) throw new DraftPullRequestError("PR_AUTH_UNAVAILABLE", "Token length is invalid.");
    if (token !== token.trim()) throw new DraftPullRequestError("PR_AUTH_UNAVAILABLE", "Token contains surrounding whitespace.");
    if (token.includes("\0") || token.includes("\r") || token.includes("\n")) {
      throw new DraftPullRequestError("PR_AUTH_UNAVAILABLE", "Token contains invalid characters.");
    }

    this.token = token;
    this.fetchImplementation = fetchImplementation;
  }

  private redact(text: string): string {
    return text.split(this.token).join("[REDACTED]");
  }

  private mapError(status: number, headers: Headers, isPost: boolean): string {
    if (status === 401) return "PR_API_UNAUTHORIZED";
    if (status === 403) {
      if (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after")) {
        return "PR_API_RATE_LIMITED";
      }
      return "PR_API_FORBIDDEN";
    }
    if (status === 404) return "PR_API_NOT_FOUND";
    if (status === 429) return "PR_API_RATE_LIMITED";
    if (status >= 300 && status < 400) return "PR_API_REDIRECT_REJECTED";
    if (status >= 500) return "PR_API_FAILED";

    if (isPost && status === 422) return "PR_CREATE_REJECTED";
    return "PR_API_FAILED";
  }

  private async executeRequest(url: string, method: string, body?: unknown): Promise<{ parsed: unknown; response: Response }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = new Headers();
      headers.set("Accept", "application/vnd.github+json");
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("User-Agent", "web-codex-orchestrator/0.1.0");
      headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);

      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      };

      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(body);
      }

      const response = await this.fetchImplementation(url, init);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let oversized = false;

      if (response.body) {
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            totalBytes += chunk.byteLength;
            if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
              oversized = true;
              controller.abort();
              break;
            }
            chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          }
        } catch (error: unknown) {
          if (oversized) {
            throw new DraftPullRequestError("PR_API_RESPONSE_TOO_LARGE", "Response exceeds size limit.");
          }
          if (error instanceof Error && error.name === "AbortError") {
            throw new DraftPullRequestError(method === "POST" ? "PR_CREATE_UNCERTAIN" : "PR_API_FAILED", "Request timeout");
          }
          throw new DraftPullRequestError(method === "POST" ? "PR_CREATE_UNCERTAIN" : "PR_API_FAILED", "Socket/read failure");
        }
      }

      if (oversized) {
        throw new DraftPullRequestError("PR_API_RESPONSE_TOO_LARGE", "Response exceeds size limit.");
      }
      const text = Buffer.concat(chunks, totalBytes).toString("utf8");
      const retryAfterMs = parseGitHubRetryAfterMs(response.headers);

      if (method === "GET" && response.status !== 200) {
        const code = this.mapError(response.status, response.headers, false) as ConstructorParameters<typeof DraftPullRequestError>[0];
        const diag = this.redact(text).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES);
        throw new DraftPullRequestError(code, `Request failed with status ${response.status}: ${diag}`, code === "PR_API_RATE_LIMITED" ? retryAfterMs : null);
      }
      if (method === "POST" && response.status !== 201) {
        const diag = this.redact(text).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES);
        let code: ConstructorParameters<typeof DraftPullRequestError>[0] = "PR_API_FAILED";
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          code = this.mapError(response.status, response.headers, true) as ConstructorParameters<typeof DraftPullRequestError>[0];
        } else if (response.status === 429) {
          code = "PR_API_RATE_LIMITED";
        } else if (response.status === 422) {
          throw new DraftPullRequestError("PR_CREATE_REJECTED", `Creation rejected: ${diag}`);
        } else if (response.status >= 300 && response.status < 400) {
          code = "PR_API_REDIRECT_REJECTED";
        } else {
          throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", `Ambiguous create outcome: ${response.status} ${diag}`);
        }
        throw new DraftPullRequestError(code, `Request failed with status ${response.status}: ${diag}`, code === "PR_API_RATE_LIMITED" ? retryAfterMs : null);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Response not JSON.");
        throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Response not JSON.");
      }

      return { parsed, response };
    } catch (error: unknown) {
      if (error instanceof DraftPullRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Request aborted.");
        throw new DraftPullRequestError("PR_API_FAILED", "Request aborted.");
      }
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      const message = this.redact(rawMessage).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES);
      if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", `Network/Socket error: ${message}`);
      throw new DraftPullRequestError("PR_API_FAILED", `Network/Socket error: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validatePR(pr: unknown): GitHubPullRequest {
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new Error("PR is not an object");
    const value = pr as Record<string, any>;
    if (typeof value.number !== "number" || value.number <= 0) throw new Error("Invalid number");
    if (typeof value.html_url !== "string") throw new Error("Invalid html_url");
    if (value.state !== "open" && value.state !== "closed") throw new Error("Invalid state");
    if (typeof value.draft !== "boolean") throw new Error("Invalid draft");
    if (value.merged_at !== null && typeof value.merged_at !== "string") throw new Error("Invalid merged_at");
    if (typeof value.title !== "string") throw new Error("Invalid title");
    if (value.body !== null && typeof value.body !== "string") throw new Error("Invalid body");
    if (!value.head || typeof value.head.ref !== "string" || typeof value.head.sha !== "string") throw new Error("Invalid head");
    if (value.head.repo && typeof value.head.repo.full_name !== "string") throw new Error("Invalid head.repo.full_name");
    if (!value.base || typeof value.base.ref !== "string" || typeof value.base.sha !== "string") throw new Error("Invalid base");
    if (value.base.repo && typeof value.base.repo.full_name !== "string") throw new Error("Invalid base.repo.full_name");

    return {
      number: value.number,
      html_url: value.html_url,
      state: value.state,
      draft: value.draft,
      merged_at: value.merged_at,
      title: value.title,
      body: value.body,
      head: {
        ref: value.head.ref,
        sha: value.head.sha,
        repo: value.head.repo ? { full_name: value.head.repo.full_name } : null,
      },
      base: {
        ref: value.base.ref,
        sha: value.base.sha,
        repo: value.base.repo ? { full_name: value.base.repo.full_name } : null,
      },
    };
  }

  public async listByHead(input: { owner: string; repository: string; headOwner: string; headBranch: string }): Promise<GitHubPullRequest[]> {
    const url = new URL(`${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`);
    url.searchParams.set("state", "all");
    url.searchParams.set("head", `${input.headOwner}:${input.headBranch}`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", "1");

    const result = await this.executeRequest(url.toString(), "GET");
    if (result.response.headers.has("link")) {
      const link = result.response.headers.get("link");
      if (link && link.includes('rel="next"')) {
        throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Pagination detected in list results.");
      }
    }

    if (!Array.isArray(result.parsed)) {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "List response is not an array.");
    }

    try {
      return result.parsed.map((item) => this.validatePR(item));
    } catch {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Invalid PR object in list response.");
    }
  }

  public async get(input: { owner: string; repository: string; pullNumber: number }): Promise<GitHubPullRequest> {
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullNumber}`;
    const result = await this.executeRequest(url, "GET");
    try {
      return this.validatePR(result.parsed);
    } catch {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Invalid PR object in get response.");
    }
  }

  public async createDraft(input: { owner: string; repository: string; title: string; body: string; head: string; base: string }): Promise<GitHubPullRequest> {
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`;
    const body = {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      maintainer_can_modify: false,
      draft: true,
    };

    const result = await this.executeRequest(url, "POST", body);
    try {
      return this.validatePR(result.parsed);
    } catch {
      throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Invalid PR object in create response.");
    }
  }
}
