import { DraftPullRequestError, GitHubPullRequest, GitHubPullRequestClient } from "./contracts.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_ERROR_DIAGNOSTIC_BYTES = 8_192;

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
    
    if (isPost && status === 422) return "PR_CREATE_REJECTED"; // Will be caught higher up, or we can just map it here but POST logic is different.
    return "PR_API_FAILED";
  }

  private async executeRequest(url: string, method: string, body?: any): Promise<any> {
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
      
      let dataBuffer = Buffer.alloc(0);
      let text = "";
      let isOversized = false;

      if (response.body) {
        // use async iterator
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            dataBuffer = Buffer.concat([dataBuffer, chunk]);
            if (dataBuffer.length > MAXIMUM_RESPONSE_BYTES) {
              isOversized = true;
              break;
            }
          }
        } catch (err: any) {
          if (err.name === "AbortError") throw new DraftPullRequestError("PR_API_FAILED", "Request timeout");
          throw new DraftPullRequestError("PR_API_FAILED", "Socket/read failure");
        }
      }

      if (isOversized) {
        throw new DraftPullRequestError("PR_API_RESPONSE_TOO_LARGE", "Response exceeds size limit.");
      }
      text = dataBuffer.toString("utf8");

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
           // Ambiguous CREATE_UNCERTAIN
           throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", `Ambiguous create outcome: ${response.status} ${diag}`);
        }
        throw new DraftPullRequestError(code, `Request failed with status ${response.status}: ${diag}`);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Response not JSON.");
        throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Response not JSON.");
      }

      return { parsed, response };

    } catch (err: any) {
      if (err instanceof DraftPullRequestError) throw err;
      if (err.name === "AbortError") {
        if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Request aborted.");
        throw new DraftPullRequestError("PR_API_FAILED", "Request aborted.");
      }
      const message = err.message ? this.redact(err.message).substring(0, MAXIMUM_ERROR_DIAGNOSTIC_BYTES) : "Unknown error";
      if (method === "POST") throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", `Network/Socket error: ${message}`);
      throw new DraftPullRequestError("PR_API_FAILED", `Network/Socket error: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validatePR(pr: any): GitHubPullRequest {
    if (!pr || typeof pr !== "object") throw new Error("PR is not an object");
    if (typeof pr.number !== "number" || pr.number <= 0) throw new Error("Invalid number");
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
    } catch (err: any) {
      throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Invalid PR object in list response.");
    }
  }

  public async get(input: { owner: string; repository: string; pullNumber: number; }): Promise<GitHubPullRequest> {
    const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullNumber}`;
    const result = await this.executeRequest(url, "GET");
    try {
      return this.validatePR(result.parsed);
    } catch (err: any) {
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

    let result: any;
    try {
      result = await this.executeRequest(url, "POST", body);
    } catch (err: any) {
      // executeRequest already handles POST errors throwing correctly mapped ones like CREATE_UNCERTAIN or REJECTED.
      throw err;
    }

    try {
      return this.validatePR(result.parsed);
    } catch (err: any) {
      throw new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Invalid PR object in create response.");
    }
  }
}
