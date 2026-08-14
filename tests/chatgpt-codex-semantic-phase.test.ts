import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptCodexImplementationClient } from "../src/web-bridge/chatgpt-codex-implementation-client.js";
import { chatGptCodexAuthorPrompt, chatGptCodexReviewPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";

const profile: any = { model: "gpt-5.6-sol", reasoning_effort: "high" };
const dirs = { scratchDirectory: "/tmp/wco-semantic-scratch", authorityDirectory: "/tmp/wco-semantic-authority" };

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
      return { thread_id: `thread-${requests.length}`, output: { protocol_version: "wco-chatgpt-codex-v1", kind: request.output_schema.properties.kind.enum[0], payload_json: "{}" } };
    },
  } as any);

  await client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }) });
  await client.turn({ profile, ...dirs, prompt: chatGptCodexReviewPrompt({ run_id: `TASK:${"b".repeat(64)}`, result_bundle_sha256: "c".repeat(64), published_commit_sha: "d".repeat(40), pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, { exact: true }) });

  assert.deepEqual(requests[0].output_schema.properties.kind.enum, ["repository_command", "contract_sealed"]);
  assert.deepEqual(requests[1].output_schema.properties.kind.enum, ["web_verdict"]);
  assert.equal(requests[0].read_only, true);
  assert.equal(requests[1].read_only, true);
  assert.equal(requests[0].network_access, false);
  assert.equal(requests[1].network_access, false);
});

test("unknown semantic prompt fails before provider invocation", async () => {
  let calls = 0;
  const client = new ChatGptCodexSemanticClient({ async checkAvailability() {}, async turn() { calls += 1; throw new Error("must not run"); } } as any);
  await assert.rejects(client.turn({ profile, ...dirs, prompt: "unmarked prompt" }), /missing a closed WCO phase marker/i);
  assert.equal(calls, 0);
});

test("semantic provider turn has a hard local deadline", async () => {
  const client = new ChatGptCodexSemanticClient(abortingAgent(), 0.002);
  await assert.rejects(
    client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }) }),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_TURN_TIMEOUT",
  );
});

test("implementation planner turn has the same hard local deadline", async () => {
  const client = new ChatGptCodexImplementationClient(abortingAgent(), 0.002);
  await assert.rejects(
    client.propose({
      profile: { model: "gpt-5.6-terra", reasoning_effort: "high" } as any,
      jobId: "job-1",
      runId: `TASK:${"b".repeat(64)}`,
      workspacePath: "/tmp/wco-implementation-workspace",
      acceptedBundlePath: "/tmp/wco-implementation-bundle",
    }),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_TURN_TIMEOUT",
  );
});

test("external cancellation is not mislabeled as an internal timeout", async () => {
  const controller = new AbortController();
  const client = new ChatGptCodexSemanticClient(abortingAgent(), 1);
  const promise = client.turn({ profile, ...dirs, prompt: chatGptCodexAuthorPrompt({ owner: "local", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "change app", ttl_seconds: 60 }), signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error: any) => error?.code !== "WEB_CHATGPT_CODEX_TURN_TIMEOUT");
});
