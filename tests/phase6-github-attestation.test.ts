import test from "node:test";
import assert from "node:assert";
import { attestGitHubPullRequest, GitHubRestAttestationClient, type GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";

class MockGitHubClient implements GitHubAttestationClient {
  public mockResponse: any;
  public mockError: any;
  public lastCall: any;

  async getPullRequest(owner: string, repo: string, prNumber: number) {
    this.lastCall = { owner, repo, prNumber };
    if (this.mockError) throw this.mockError;
    return this.mockResponse;
  }
}

test("Phase 6 GitHub Attestation: success path", async () => {
  const client = new MockGitHubClient();
  client.mockResponse = {
    number: 123,
    html_url: "https://github.com/owner/repo/pull/123",
    state: "open",
    draft: true,
    merged: false,
    merged_at: null,
    title: "Test PR",
    head: { ref: "codex/task", sha: "abc123def456" },
    base: { ref: "main" }
  };

  const expected = { headBranch: "codex/task", headSha: "abc123def456", baseBranch: "main" };
  const att = await attestGitHubPullRequest(client, "owner", "repo", 123, expected);

  assert.equal(att.number, 123);
  assert.equal(att.state, "open");
  assert.equal(att.draft, true);
  assert.equal(att.head_branch, "codex/task");
  assert.equal(att.head_sha, "abc123def456");
  assert.ok(att.title_sha256);
});

test("Phase 6 GitHub Attestation: rejects merged PR", async () => {
  const client = new MockGitHubClient();
  client.mockResponse = {
    number: 123, html_url: "url", state: "open", draft: false,
    merged: true, merged_at: "2026-01-01T00:00:00Z", title: "Test",
    head: { ref: "branch", sha: "sha" }, base: { ref: "main" }
  };
  const expected = { headBranch: "branch", headSha: "sha", baseBranch: "main" };

  await assert.rejects(
    attestGitHubPullRequest(client, "owner", "repo", 123, expected),
    (err: any) => err instanceof ResultBundleError && err.code === "RESULT_PR_MERGED"
  );
});

test("Phase 6 GitHub Attestation: rejects mismatching identity", async () => {
  const client = new MockGitHubClient();
  client.mockResponse = {
    number: 123, html_url: "url", state: "open", draft: false, merged: false, merged_at: null, title: "Test",
    head: { ref: "wrong-branch", sha: "sha" }, base: { ref: "main" }
  };
  const expected = { headBranch: "right-branch", headSha: "sha", baseBranch: "main" };

  await assert.rejects(
    attestGitHubPullRequest(client, "owner", "repo", 123, expected),
    (err: any) => err instanceof ResultBundleError && err.code === "RESULT_PR_IDENTITY_MISMATCH"
  );
});

test("Phase 6 GitHub REST client pins token-bearing requests to api.github.com", async () => {
  let observedUrl = "";
  let observedRedirect: RequestRedirect | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    observedUrl = String(input);
    observedRedirect = init?.redirect;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GitHubRestAttestationClient("secret-token", 1024, fetchImpl, 1000);
  const value = await client.getPullRequest("owner", "repo", 7);
  assert.deepEqual(value, { ok: true });
  assert.equal(observedUrl, "https://api.github.com/repos/owner/repo/pulls/7");
  assert.equal(observedRedirect, "manual");
});

test("Phase 6 GitHub REST client aborts a hung request at its deadline", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw init?.signal?.reason ?? new Error("aborted");
  };
  const client = new GitHubRestAttestationClient("secret-token", 1024, fetchImpl, 10);
  await assert.rejects(
    () => client.getPullRequest("owner", "repo", 7),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_PR_API_FAILED",
  );
});

test("Phase 6 GitHub REST client cancels streamed bodies that exceed the response cap", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  const fetchImpl: typeof fetch = async () => new Response(body, { status: 200 });
  const client = new GitHubRestAttestationClient("secret-token", 8, fetchImpl, 1000);
  await assert.rejects(
    () => client.getPullRequest("owner", "repo", 7),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_PR_API_RESPONSE_TOO_LARGE",
  );
});
