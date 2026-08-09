import test from "node:test";
import assert from "node:assert/strict";
import { DraftPullRequestError } from "../src/pull-request/contracts.js";
import { GitHubRestPullRequestClient } from "../src/pull-request/github-rest-client.js";

function setupGlobalFetch(responses: { url: string; method: string; status: number; body?: any }[]) {
  const originalFetch = global.fetch;
  const requests: { url: string; method: string; headers: any; body: any }[] = [];

  global.fetch = async (url: any, options: any) => {
    requests.push({
      url: url.toString(),
      method: options.method || "GET",
      headers: options.headers,
      body: options.body
    });

    const matched = responses.find(r => r.url === url.toString() && r.method === (options.method || "GET"));
    if (!matched) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(matched.body ? JSON.stringify(matched.body) : null, { status: matched.status });
  };

  return {
    requests,
    restore: () => { global.fetch = originalFetch; }
  };
}

test("P5B-006/P5B-038: http-contract and mutation-budget", async () => {
  const fakeCandidate = {
    number: 123,
    html_url: "url",
    state: "open",
    draft: true,
    title: "Draft PR",
    merged_at: null,
    body: "Body",
    head: { ref: "feature", sha: "sha", repo: { full_name: "foo/bar" } },
    base: { ref: "main", sha: "sha", repo: { full_name: "foo/bar" } }
  };

  const mock = setupGlobalFetch([
    { url: "https://api.github.com/repos/foo/bar/pulls?state=all&head=foo%3Afeature&per_page=100&page=1", method: "GET", status: 200, body: [fakeCandidate] },
    { url: "https://api.github.com/repos/foo/bar/pulls/123", method: "GET", status: 200, body: fakeCandidate },
    { url: "https://api.github.com/repos/foo/bar/pulls", method: "POST", status: 201, body: fakeCandidate }
  ]);

  try {
    const client = new GitHubRestPullRequestClient("test-token");

    const list = await client.listByHead({ owner: "foo", repository: "bar", headOwner: "foo", headBranch: "feature" });
    assert.equal(list.length, 1);

    const get = await client.get({ owner: "foo", repository: "bar", pullNumber: 123 });
    assert.equal(get.number, 123);

    const create = await client.createDraft({ owner: "foo", repository: "bar", title: "Test", body: "Body", head: "feature", base: "main" });
    assert.equal(create.number, 123);

    assert.equal(mock.requests.length, 3);

    // P5B-006: Exact headers used
    for (const req of mock.requests) {
      const getHeader = (key: string) => {
        if (req.headers && typeof req.headers.get === "function") return req.headers.get(key) || req.headers.get(key.toLowerCase());
        if (req.headers) return req.headers[key] || req.headers[key.toLowerCase()];
        return undefined;
      };
      assert.equal(getHeader("Accept"), "application/vnd.github+json");
      assert.equal(getHeader("Authorization"), "Bearer test-token");
      assert.equal(getHeader("X-GitHub-Api-Version"), "2026-03-10");
      assert.equal(getHeader("User-Agent"), "web-codex-orchestrator");
    }

    // P5B-007: verify payload
    const postReq = mock.requests.find(r => r.method === "POST");
    assert.ok(postReq);
    const body = JSON.parse(postReq.body);
    assert.equal(body.draft, true);
    assert.equal(body.maintainer_can_modify, false);

    // P5B-038: No PATCH, PUT, DELETE
    const forbiddenMethods = ["PATCH", "PUT", "DELETE"];
    for (const req of mock.requests) {
      assert.equal(forbiddenMethods.includes(req.method), false);
    }
  } finally {
    mock.restore();
  }
});

test("P5B-HTTP-HARD-001 unsafe pull request numbers fail before network access", async () => {
  let fetchCalled = false;
  const client = new GitHubRestPullRequestClient("test-token", async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(
    () => client.get({ owner: "foo", repository: "bar", pullNumber: 1.5 }),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_REQUEST_INVALID",
  );
  assert.equal(fetchCalled, false);
});

test("P5B-HTTP-HARD-002 oversized streamed responses are cancelled and fail closed", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_048_577));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new GitHubRestPullRequestClient("test-token", async () => new Response(body, { status: 200 }));

  await assert.rejects(
    () => client.listByHead({ owner: "foo", repository: "bar", headOwner: "foo", headBranch: "feature" }),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_API_RESPONSE_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});
