import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { readProviderBudgetUsage, recordProviderBudgetUsage } from "../src/web-bridge/provider-budget-store.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

const RUN_ID = `TASK-BUDGET:${"a".repeat(64)}`;
const MEASUREMENT = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, duration_ms: 250 };

function budgetConfig(maximumTotalSeconds = 7_200) {
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
        maximum_total_agent_turns: 8,
        maximum_turn_seconds: 900,
        maximum_total_seconds: maximumTotalSeconds,
        maximum_total_input_tokens: 2_000_000,
        maximum_total_output_tokens: 300_000,
      },
    },
  } as any;
}

test("provider budget ledger is durable and idempotent but rejects conflicting replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-budget-"));
  const first = await recordProviderBudgetUsage({ stateDirectory: root, runId: RUN_ID, key: "author:1", phase: "author", measurement: MEASUREMENT });
  assert.deepEqual(first, { turns: 1, input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, duration_ms: 250 });

  const replay = await recordProviderBudgetUsage({ stateDirectory: root, runId: RUN_ID, key: "author:1", phase: "author", measurement: MEASUREMENT });
  assert.deepEqual(replay, first);
  assert.deepEqual(await readProviderBudgetUsage(root, RUN_ID), first);

  await assert.rejects(
    recordProviderBudgetUsage({ stateDirectory: root, runId: RUN_ID, key: "author:1", phase: "author", measurement: { ...MEASUREMENT, output_tokens: 4 } }),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID",
  );
});

test("provider budget ledger fails closed on corrupt receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-budget-corrupt-"));
  await recordProviderBudgetUsage({ stateDirectory: root, runId: RUN_ID, key: "review:1", phase: "review", measurement: MEASUREMENT });
  const target = path.join(root, "bridge", "provider-budget", "TASK-BUDGET", "a".repeat(64), "usage.json");
  await writeFile(target, "{not-json}\n", "utf8");
  await assert.rejects(
    readProviderBudgetUsage(root, RUN_ID),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID",
  );
});

test("provider budget reads reject symlinked state ancestry", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-budget-link-"));
  const state = path.join(root, "state");
  const attacker = path.join(root, "attacker");
  await mkdir(state);
  await mkdir(attacker);
  await symlink(attacker, path.join(state, "bridge"), "dir");
  await assert.rejects(
    readProviderBudgetUsage(state, RUN_ID),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_STATE_INVALID",
  );
});

test("task-wide provider wall-clock budget blocks new review authority before relay creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-budget-time-"));
  const state = path.join(root, "state");
  const bridgeDirectory = path.join(root, "bridge-runtime");
  await mkdir(state);
  await recordProviderBudgetUsage({
    stateDirectory: state,
    runId: RUN_ID,
    key: "author:slow",
    phase: "author",
    measurement: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3, duration_ms: 1_000 },
  });

  const bridge = new ChatGptCodexWebBridge(budgetConfig(1), bridgeDirectory, state);
  await assert.rejects(
    bridge.createFinalReviewJob({
      run_id: RUN_ID,
      result_bundle_sha256: "b".repeat(64),
      published_commit_sha: "c".repeat(40),
      pull_request_url: "https://github.com/example/repo/pull/1",
      review_round: 1,
    }, "wall-clock-review"),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_EXHAUSTED",
  );

  const store = new RelayFileStore(path.join(bridgeDirectory, "chatgpt-codex"));
  const records = await store.list("local-chatgpt-codex");
  assert.equal(records.filter((record) => record.kind === "final_review").length, 0);
});
