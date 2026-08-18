import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareTask } from "../src/run/preparation-service.js";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type WebContractEnvelope, type WebVerdictEnvelope } from "../src/web-bridge/contracts.js";
import { materializeTaskBundle } from "../src/web-bridge/task-contract-materializer.js";

const run = promisify(execFile);
const PROVIDER_PROTOCOL = "wco-chatgpt-codex-v1";
const PROVIDER_USAGE = { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 };

function providerEnvelope(kind: "repository_command" | "web_verdict", payload: unknown) {
  return { protocol_version: PROVIDER_PROTOCOL, kind, payload_json: JSON.stringify(payload) };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-context-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const state = path.join(root, "state");
  const bridgeDirectory = path.join(root, "bridge");
  const configPath = path.join(root, "config.json");
  await mkdir(repo);
  await run("git", ["init", "--bare", remote]);
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.name", "WCO Review Test"], { cwd: repo });
  await run("git", ["config", "user.email", "wco-review@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "published-before\n");
  await writeFile(path.join(repo, "caller.txt"), "caller invariant: app must start with published-before\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "review-context-fixture", private: true, scripts: { test: "node --test" } }));
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  await run("git", ["remote", "add", "origin", remote], { cwd: repo });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  const config: any = {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { repo: { path: repo, remote: "origin", expected_remote_urls: [remote], fetch_policy: "never" } },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: { maximum_implementation_iterations: 4, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 32, maximum_turn_seconds: 900, maximum_total_seconds: 7_200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 },
    },
    verification: { allowed_executables: ["node", "npm"], allowed_environment_keys: ["CI"], maximum_command_seconds: 60, maximum_output_bytes: 1_000_000, maximum_file_bytes: 8_388_608, maximum_changed_files: 10, maximum_diff_lines: 1_000, allowed_generated_paths: [] },
    publish: { identity: { name: "WCO Review Test", email: "wco-review@example.invalid" }, authentication: { mode: "none" } },
    result_bundle: { github_attestation: "optional" },
    ui: { interactive: true },
  };
  await writeFile(configPath, JSON.stringify(config));

  const jobId = "review-context-job";
  const contract: WebContractEnvelope = {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    repository: { repository_id: "repo", base_branch: "main", base_commit: base },
    user_intent: "exercise independent exact repository review",
    title: "Review exact repository context",
    goal: "Exercise the review repository lookup path",
    non_goals: ["No production mutation"],
    architecture_decisions: ["Review immutable Git evidence"],
    allowed_paths: ["app.txt"],
    forbidden_paths: [".git/**"],
    acceptance_criteria: [{ id: "AC-001", description: "Review can inspect exact published source" }],
    verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
    risk_policy: { network_access: false, secrets_required: false, notes: [] },
    delivery: { remote: "origin", base_branch: "main", branch_name: "codex/review-context-test", draft: true, auto_merge: false },
    sources: [],
    implementation_strategy: ["No-op fixture"],
    project_map_hints: ["app.txt", "caller.txt"],
  };
  const task = await materializeTaskBundle({ envelope: contract, repository: contract.repository, config, stateDirectory: state });
  const prepared = await prepareTask({ archivePath: task.archive_path, stateDirectory: state, configPath });
  return { repo, state, bridgeDirectory, config, prepared, base };
}

test("reviewer can inspect immutable out-of-diff source and keeps large evidence in the existing thread", async () => {
  const item = await fixture();
  const bridge = new ChatGptCodexWebBridge(item.config, item.bridgeDirectory, item.state);
  const target = bridge as any;
  target.ensureAuthorizedForProviderTurn = async () => undefined;

  const resultBundleSha = "b".repeat(64);
  const review = await bridge.createFinalReviewJob({
    run_id: item.prepared.run_id,
    result_bundle_sha256: resultBundleSha,
    published_commit_sha: item.base,
    pull_request_url: "https://github.com/example/repo/pull/1",
    review_round: 1,
  }, "review-context-create");
  await bridge.submitFinalReviewEvidence(review.job_id, { exact_result: true, large_evidence_marker: "z".repeat(32_768) }, "review-context-evidence");

  // Mutable local state must not affect semantic review evidence. The reviewer
  // is required to read the exact immutable published commit instead.
  await writeFile(path.join(item.repo, "app.txt"), "tampered-working-tree\n");

  const prompts: Array<{ prompt: string; threadId?: string }> = [];
  let calls = 0;
  const verdict: WebVerdictEnvelope = {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    review_id: review.job_id,
    run_id: item.prepared.run_id,
    result_bundle_sha256: resultBundleSha,
    verdict: "APPROVE",
    summary: "Exact immutable repository context was inspected.",
    findings: [],
  };
  target.semantic = {
    async checkAvailability() {},
    async turn(options: any) {
      calls += 1;
      prompts.push({ prompt: options.prompt, threadId: options.threadId });
      if (calls === 1) return { thread_id: "review-context-thread", output: providerEnvelope("repository_command", { operation: "read", paths: ["app.txt"] }), usage: PROVIDER_USAGE };
      if (calls === 2) return { thread_id: "review-context-thread", output: providerEnvelope("web_verdict", verdict), usage: PROVIDER_USAGE };
      throw new Error("unexpected extra semantic review turn");
    },
  };

  assert.deepEqual(await bridge.waitForVerdict(review.job_id), verdict);
  assert.equal(calls, 2);
  assert.equal(prompts[0].threadId, undefined);
  assert.equal(prompts[1].threadId, "review-context-thread", "bounded repository evidence must continue the same review thread");
  assert.match(prompts[1].prompt, /published-before/);
  assert.doesNotMatch(prompts[1].prompt, /tampered-working-tree/);
  assert.doesNotMatch(prompts[1].prompt, /large_evidence_marker/);
  assert.doesNotMatch(prompts[1].prompt, /Exact review evidence:/);
  assert.ok(Buffer.byteLength(prompts[1].prompt, "utf8") < Buffer.byteLength(prompts[0].prompt, "utf8"), "follow-up must not retransmit the large initial review evidence");

  const restarted = new ChatGptCodexWebBridge(item.config, item.bridgeDirectory, item.state);
  (restarted as any).ensureAuthorizedForProviderTurn = async () => undefined;
  (restarted as any).semantic = { async checkAvailability() {}, async turn() { throw new Error("sealed verdict must replay without provider call"); } };
  assert.deepEqual(await restarted.waitForVerdict(review.job_id), verdict);
});

test("review exact-repository lookup loop is bounded instead of consuming provider turns forever", async () => {
  const item = await fixture();
  const bridge = new ChatGptCodexWebBridge(item.config, item.bridgeDirectory, item.state);
  const target = bridge as any;
  target.ensureAuthorizedForProviderTurn = async () => undefined;
  const review = await bridge.createFinalReviewJob({
    run_id: item.prepared.run_id,
    result_bundle_sha256: "c".repeat(64),
    published_commit_sha: item.base,
    pull_request_url: "https://github.com/example/repo/pull/2",
    review_round: 1,
  }, "review-context-budget-create");
  await bridge.submitFinalReviewEvidence(review.job_id, { exact_result: true }, "review-context-budget-evidence");

  let calls = 0;
  target.semantic = {
    async checkAvailability() {},
    async turn() {
      calls += 1;
      return {
        thread_id: "bounded-review-thread",
        output: providerEnvelope("repository_command", { operation: "read", regions: [{ path: "app.txt", start_byte: 0, end_byte_exclusive: Math.min(1 + calls, 16) }] }),
        usage: PROVIDER_USAGE,
      };
    },
  };

  await assert.rejects(
    bridge.waitForVerdict(review.job_id),
    (error: any) => error?.code === "WEB_CHATGPT_CODEX_REVIEW_CONTEXT_BUDGET",
  );
  assert.equal(calls, 9, "the ninth attempt may request context, but WCO must reject it instead of executing an unbounded ninth lookup");
});
