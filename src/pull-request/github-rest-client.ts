import { DraftPullRequestError, GitHubPullRequest, GitHubPullRequestClient } from "./contracts.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_ERROR_DIAGNOSTIC_BYTES = 8_192;
const USER_AGENT = "web-codex-orchestrator";

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

  private async readBoundedResponseBody(response: Response): Promise<string> {
    if (!response.body) return "";

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^\d+$/.test(contentLength)) {
      const declared = Number(contentLength);
      if (Number.isSafeInteger(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new DraftPullRequestError("PR_API_RESPONSE_TOO_LARGE", "Response exceeds size limit.");
      }
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new DraftPullRequestError("PR_API_RESPONSE_TOO_LARGE", "Response exceeds size limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof DraftPullRequestError) throw error;
      if ((error as { name?: unknown })?.name === "AbortError") {
        throw new DraftPullRequestError("PR_API_FAILED", "Request timeout");
      }
      throw new DraftPullRequestError("PR_API_FAILED", "Socket/read failure");
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  }

  private async executeRequest(url: string, method: string, body?: unknown): Promise<{ parsed: unknown; response: Response }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = new Headers();
      headers.set("Accept", "application/vnd.github+json");
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("User-Agent", USER_AGENT);
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
      const text = await this.readBoundedResponseBody(response);

      if (method === "GET" && response.status !== 200) {
        const code = this.mapError(response.status, response.headers, false) as any;
        const diag = this.redact(text).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES);
        throw new DraftPullRequestError(code, `Request failed with status ${response.status}: ${diag}`);
      } else if (method === "POST" && response.status !== 201) {
        const diag = this.redact(text).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES);
        let code = "PR_API_FAILED" as any;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          code = this.mapError(response.status, response.headers, true) as any;
        } else if (response.status === 429) {
          code = "PR_API_RATE_LIMITED";
        } else if (response.status === 422) {
          throw new DraftPullRequestError("PR_CREATE_REJECTED", `Creation rejected: ${diag}`);
        } else if (response.status >= 300 && response.status < 400) {
          code = "PR_API_REDIRECT_REJECTED";
        } else {
          throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", `Ambiguous create outcome: ${response.status} ${diag}`);
        }
        throw new DraftPullRequestError(code, `Request failed with status ${response.status}: ${diag}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Response not JSON.");
        throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Response not JSON.");
      }

      return { parsed, response };
    } catch (error) {
      if (error instanceof DraftPullRequestError) throw error;
      if ((error as { name?: unknown })?.name === "AbortError") {
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

  private validatePR(pr: any): GitHubPullRequest {
    if (!pr || typeof pr !== "object") throw new Error("PR is not an object");
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error("Invalid number");
    if (typeof pr.html_url !== "string") throw new Error("Invalid html_url");
    if (pr.state !== "open" && pr.state !== "closed") throw new Error("Invalid state");
    if (typeof pr.draft !== "boolean") throw new Error("Invalid draft");
    if (pr.merged_at !== null && typeof pr.merged_at !== "string") throw new Error("Invalid merged_at");
    if (typeof pr.title !== "string") throw new Error("Invalid title");
    if (pr.body !== null && typeof pr.body !== "string") throw new Error("Invalid body");
    if (!pr.head || typeof pr.head.ref !== "string" || typeof pr.head.sha !== "string") throw new Error("Invalid head");
    if (pr.head.repo && typeof pr.head.repo.full_name !== "string") throw new Error("Invalid head.repo.full_name");
    if (!pr.base || typeof pr.base.ref !== "string" || typeof pr.base.sha !== "string") throw new Error("Invalid base");
    if (pr.base.repo && typeof pr.base.repo.full_name !== "string") throw new Error("Invalid base.repo.full_name");

    return {
      number: pr.number,
      html_url: pr.html_url,
      state: pr.state as "open" | "closed",
      draft: pr.draft,
      merged_at: pr.merged_at,
      title: pr.title,
      body: pr.body,
      head: {
        ref: pr.head.ref,
        sha: pr.head.sha,
        repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null
      },
      base: {
        ref: pr.base.ref,
        sha: pr.base.sha,
        repo: pr.base.repo ? { full_name: pr.base.repo.full_name } : null
      }
    };
  }

  public async listByHead(input: { owner: string; repository: string; headOwner: string; headBranch: string; }): Promise<GitHubPullRequest[]> {
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
      return result.parsed.map((item: any) => this.validatePR(item));
    } catch {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Invalid PR object in list response.");
    }
  }

  public async get(input: { owner: string; repository: string; pullNumber: number; }): Promise<GitHubPullRequest> {
    if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0) {
      throw new DraftPullRequestError("PR_REQUEST_INVALID", "Pull request number must be a positive safe integer.");
    }
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullNumber}`;
    const result = await this.executeRequest(url, "GET");
    try {
      return this.validatePR(result.parsed);
    } catch {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Invalid PR object in get response.");
    }
  }

  public async createDraft(input: { owner: string; repository: string; title: string; body: string; head: string; base: string; }): Promise<GitHubPullRequest> {
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`;

    const body = {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      maintainer_can_modify: false,
      draft: true
    };

    const result = await this.executeRequest(url, "POST", body);
    try {
      return this.validatePR(result.parsed);
    } catch {
      throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Invalid PR object in create response.");
    }
  }
}
