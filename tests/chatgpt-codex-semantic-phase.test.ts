import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptCodexImplementationClient } from "../src/web-bridge/chatgpt-codex-implementation-client.js";
import { chatGptCodexAuthorPrompt, chatGptCodexRepositoryResultPrompt, chatGptCodexReviewPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const profile: any = { model: "gpt-5.6-sol", reasoning_effort: "high" };
const dirs = { scratchDirectory: "/tmp/wco-semantic-scratch", authorityDirectory: "/tmp/wco-semantic-authority" };
const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };

function abortingAgent() {
  return {
    async checkAvailability() {},
    async turn(request: any) {
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted) { reject(new Error("aborted")); return; }
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    },
  } as any;
}

test("semantic SDK turn exposes only the authority kind valid for its closed WCO phase", async () => {
  const requests: any[] = [];
  const client = new ChatGptCodexSemanticClient({
    async checkAvailability() {},
    async turn(request: any) {
      requests.push(request);
      return { thread_id: `thread-${requests.length}`, output: { protocol_version: "wco-chatgpt-codex-v1", kind: request.output_schema.properties.kind.enum[0], payload_json: "{}" }, usage };
    },
  } as any);

  const author = await client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }, "job-1") });
  const review = await client.turn({ profile, ...dirs, prompt: chatGptCodexReviewPrompt({ run_id: `TASK:${"b".repeat(64)}`, result_bundle_sha256: "c".repeat(64), published_commit_sha: "d".repeat(40), pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, { exact: true }, "review-1") });

  assert.deepEqual(requests[0].output_schema.properties.kind.enum, ["repository_command", "contract_sealed"]);
  assert.deepEqual(requests[1].output_schema.properties.kind.enum, ["web_verdict"]);
  assert.deepEqual(author.usage, usage);
  assert.deepEqual(review.usage, usage);
  assert.equal(requests[0].read_only, true);
  assert.equal(requests[1].read_only, true);
  assert.equal(requests[0].network_access, false);
  assert.equal(requests[1].network_access, false);
});

test("semantic prompts expose the closed JSON payload wire contracts", () => {
  const request = { owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 } as const;
  for (const prompt of [chatGptCodexAuthorPrompt(request, "job-exact"), chatGptCodexRepositoryResultPrompt({ exact: true }, request, "job-exact")]) {
    assert.match(prompt, /\{"operation":"summary"\}/);
    assert.match(prompt, /\{"operation":"read","paths":\["package.json","README.md"\]\}/);
    assert.match(prompt, /Never put repository_id, commands, argv, shell/);
    assert.match(prompt, /protocol_version, job_id, repository, user_intent/);
    assert.match(prompt, /protocol_version must be exactly "wco-web-bridge-v1" and job_id must be exactly "job-exact"/);
    assert.match(prompt, /sources and risk_policy\.notes are arrays/);
    assert.match(prompt, /branch starting with "codex\/"/);
  }

  const review = chatGptCodexReviewPrompt({ run_id: `TASK:${"b".repeat(64)}`, result_bundle_sha256: "c".repeat(64), published_commit_sha: "d".repeat(40), pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, { exact: true }, "review-exact");
  assert.match(review, /closed WebVerdictEnvelope/);
  assert.match(review, /Only REVISE may include repair_operations/);
  assert.match(review, /create_file, replace_file, or delete_file/);
  assert.match(review, /review_id must be exactly "review-exact"/);
});

test("successful semantic provider output without measurable usage fails closed", async () => {
  const client = new ChatGptCodexSemanticClient({ async checkAvailability() {}, async turn() { return { thread_id: "thread-1", output: {}, usage: undefined }; } } as any);
  await assert.rejects(client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }, "job-1") }), (error: any) => error?.code === "WEB_CHATGPT_CODEX_USAGE_UNAVAILABLE");
});

test("unknown semantic prompt fails before provider invocation", async () => {
  let calls = 0;
  const client = new ChatGptCodexSemanticClient({ async checkAvailability() {}, async turn() { calls += 1; throw new Error("must not run"); } } as any);
  await assert.rejects(client.turn({ profile, ...dirs, prompt: "unmarked prompt" }), /missing a closed WCO phase marker/i);
  assert.equal(calls, 0);
});

test("semantic provider turn has a hard local deadline", async () => {
  const client = new ChatGptCodexSemanticClient(abortingAgent(), 0.002);
  await assert.rejects(client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }, "job-1") }), (error: any) => error?.code === "WEB_CHATGPT_CODEX_TURN_TIMEOUT");
});

test("implementation planner turn has the same hard local deadline", async () => {
  const client = new ChatGptCodexImplementationClient(abortingAgent(), 0.002);
  await assert.rejects(client.propose({ profile: { model: "gpt-5.6-terra", reasoning_effort: "high" } as any, jobId: "job-1", runId: `TASK:${"b".repeat(64)}`, workspacePath: "/tmp/wco-implementation-workspace", acceptedBundlePath: "/tmp/wco-implementation-bundle" }), (error: any) => error?.code === "WEB_CHATGPT_CODEX_TURN_TIMEOUT");
});

test("trusted timeout range supports configurations above first-run 900 seconds", async () => {
  const client = new ChatGptCodexSemanticClient({ async checkAvailability() {}, async turn() { return { thread_id: "thread-1", output: { protocol_version: "wco-chatgpt-codex-v1", kind: "repository_command", payload_json: "{}" }, usage }; } } as any, 3600);
  const result = await client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }, "job-1") });
  assert.deepEqual(result.usage, usage);
  assert.throws(() => new ChatGptCodexSemanticClient({} as any, 3601), /1-3600 second range/i);
});

test("external cancellation is not mislabeled as an internal timeout", async () => {
  const controller = new AbortController();
  const client = new ChatGptCodexSemanticClient(abortingAgent(), 1);
  const promise = client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }, "job-1"), signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error: any) => error?.code !== "WEB_CHATGPT_CODEX_TURN_TIMEOUT");
});
