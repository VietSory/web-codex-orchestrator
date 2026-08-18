import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, contentDigest, type WebContractEnvelope } from "../src/web-bridge/contracts.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

const PROVIDER_PROTOCOL = "wco-chatgpt-codex-v1";
const PROVIDER_USAGE = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };

function contractFor(jobId: string): WebContractEnvelope {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change one bounded file",
    title: "Change one file",
    goal: "Change one bounded file",
    non_goals: ["No unrelated work"],
    architecture_decisions: ["Keep the existing architecture"],
    allowed_paths: ["app.txt"],
    forbidden_paths: [".git/**"],
    acceptance_criteria: [{ id: "AC-001", description: "The requested file is changed" }],
    verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
    risk_policy: { network_access: false, secrets_required: false, notes: [] },
    delivery: { remote: "origin", base_branch: "main", branch_name: "codex/task-budget-test", draft: true, auto_merge: false },
    sources: [],
    implementation_strategy: ["Make the bounded change"],
    project_map_hints: ["app.txt"],
  };
}

function config() {
  return {
    config_version: "1.0",
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: {
        maximum_implementation_iterations: 4,
        maximum_internal_review_rounds: 2,
        maximum_sol_review_rounds: 2,
        maximum_total_agent_turns: 1,
        maximum_turn_seconds: 900,
        maximum_total_seconds: 7_200,
        maximum_total_input_tokens: 2_000_000,
        maximum_total_output_tokens: 300_000,
      },
    },
  } as any;
}

test("semantic provider turn budget is task-wide across authoring and review jobs after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-task-budget-"));
  const bridgeDirectory = path.join(root, "bridge");
  const stateDirectory = path.join(root, "state");
  const trusted = config();
  const bridge = new ChatGptCodexWebBridge(trusted, bridgeDirectory, stateDirectory);
  const target = bridge as any;
  target.ensureAuthorizedForProviderTurn = async () => undefined;

  const identity = await bridge.createAuthoringJob({
    owner: "local-user",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change one bounded file",
    ttl_seconds: 86_400,
    orchestration_mode: "PAIR",
  }, "create-task-budget");
  const contract = contractFor(identity.job_id);
  let providerTurns = 0;
  target.semantic = {
    async checkAvailability() { return undefined; },
    async turn() {
      providerTurns += 1;
      return {
        thread_id: "author-thread",
        output: { protocol_version: PROVIDER_PROTOCOL, kind: "contract_sealed", payload_json: JSON.stringify(contract) },
        usage: PROVIDER_USAGE,
      };
    },
  };

  const sealed = await bridge.waitForAuthoringEvent(identity.job_id, 0);
  assert.equal(sealed?.type, "contract_sealed");
  assert.equal(providerTurns, 1);

  const runId = `TASK-${contentDigest(contract).slice(0, 32).toUpperCase()}:${"b".repeat(64)}`;
  await bridge.bindPreparedRun(identity.job_id, runId, "bind-task-budget");

  const restarted = new ChatGptCodexWebBridge(trusted, bridgeDirectory, stateDirectory);
  const restartedTarget = restarted as any;
  restartedTarget.ensureAuthorizedForProviderTurn = async () => undefined;
  restartedTarget.semantic = {
    async checkAvailability() { return undefined; },
    async turn() {
      providerTurns += 1;
      throw new Error("review provider must not be called after task-wide budget exhaustion");
    },
  };

  await assert.rejects(
    restarted.createFinalReviewJob({
      run_id: runId,
      result_bundle_sha256: "c".repeat(64),
      published_commit_sha: "d".repeat(40),
      pull_request_url: "https://github.com/example/repo/pull/1",
      review_round: 1,
    }, "review-task-budget"),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_EXHAUSTED",
  );
  assert.equal(providerTurns, 1, "review creation must not reset or consume another provider turn");

  const store = new RelayFileStore(path.join(bridgeDirectory, "chatgpt-codex"));
  const records = await store.list("local-chatgpt-codex");
  assert.equal(records.filter((record) => record.kind === "final_review").length, 0, "budget exhaustion must happen before durable review-job creation");
});
