import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareTask } from "../src/run/preparation-service.js";
import { createConfiguredWebBridge } from "../src/web-bridge/bridge-factory.js";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "../src/web-bridge/contracts.js";
import { materializeTaskBundle } from "../src/web-bridge/task-contract-materializer.js";

const run = promisify(execFile);
const PROVIDER_PROTOCOL = "wco-chatgpt-codex-v1";
const PROVIDER_USAGE = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };

function providerEnvelope(kind: "repository_command" | "contract_sealed" | "web_verdict", payload: unknown) {
  return { protocol_version: PROVIDER_PROTOCOL, kind, payload_json: JSON.stringify(payload) };
}

function injectProviderFakes(
  bridge: ChatGptCodexWebBridge,
  options: {
    semanticTurns?: Array<{ thread_id: string; output: unknown }>;
    implementation?: WebImplementationSubmission;
    counters: { auth: number; semantic: number; implementation: number };
  },
): void {
  const target = bridge as any;
  target.ensureAuthorizedForProviderTurn = async () => { options.counters.auth += 1; };
  if (options.semanticTurns) {
    target.semantic = {
      async turn(turnOptions: any) {
        options.counters.semantic += 1;
        const next = options.semanticTurns!.shift();
        assert.ok(next, `unexpected semantic provider turn: ${JSON.stringify(turnOptions)}`);
        return { ...next, usage: PROVIDER_USAGE };
      },
      async checkAvailability() { return undefined; },
    };
  }
  if (options.implementation) {
    target.implementation = {
      async propose(proposeOptions: any) {
        options.counters.implementation += 1;
        assert.equal(proposeOptions.jobId, options.implementation!.job_id);
        assert.equal(proposeOptions.runId, options.implementation!.run_id);
        return { submission: options.implementation, usage: PROVIDER_USAGE };
      },
    };
  }
}

async function fixture(mode: "PAIR" | "AUTOPILOT") {
  const root = await mkdtemp(path.join(os.tmpdir(), `wco-chatgpt-codex-${mode.toLowerCase()}-`));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const state = path.join(root, "state");
  const bridgeDirectory = path.join(root, "bridge");
  const configPath = path.join(root, "config.json");
  await mkdir(repo);
  await run("git", ["init", "--bare", remote]);
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.name", "WCO Bridge Test"], { cwd: repo });
  await run("git", ["config", "user.email", "wco-bridge@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "before\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "bridge-fixture", private: true, scripts: { test: "node --test" } }));
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
      limits: { maximum_implementation_iterations: 4, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 16, maximum_turn_seconds: 900, maximum_total_seconds: 7_200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 },
    },
    verification: { allowed_executables: ["node", "npm"], allowed_environment_keys: ["CI"], maximum_command_seconds: 60, maximum_output_bytes: 1_000_000, maximum_file_bytes: 8_388_608, maximum_changed_files: 10, maximum_diff_lines: 1_000, allowed_generated_paths: [] },
    publish: { identity: { name: "WCO Bridge Test", email: "wco-bridge@example.invalid" }, authentication: { mode: "none" } },
    result_bundle: { github_attestation: "optional" },
    ui: { interactive: true },
  };
  await writeFile(configPath, JSON.stringify(config));

  const bridge = createConfiguredWebBridge(config, bridgeDirectory, process.env, state) as ChatGptCodexWebBridge;
  const identity = await bridge.createAuthoringJob({ owner: "local-user", repository: { repository_id: "repo", base_branch: "main", base_commit: base }, user_intent: "replace app content", ttl_seconds: 86_400, orchestration_mode: mode }, `create-${mode}`);

  const contract: WebContractEnvelope = {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: identity.job_id,
    repository: { repository_id: "repo", base_branch: "main", base_commit: base },
    user_intent: "replace app content",
    title: "Replace app content",
    goal: "Replace app.txt with the requested content",
    non_goals: ["No unrelated changes"],
    architecture_decisions: ["Keep the text-file format"],
    allowed_paths: ["app.txt"],
    forbidden_paths: [".git/**"],
    acceptance_criteria: [{ id: "AC-001", description: "app.txt contains after" }],
    verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
    risk_policy: { network_access: false, secrets_required: false, notes: [] },
    delivery: { remote: "origin", base_branch: "main", branch_name: `codex/${mode.toLowerCase()}-bridge-test`, draft: true, auto_merge: false },
    sources: [{ url: "https://example.invalid/spec", title: "Fixture spec", accessed_at: "2026-08-14T00:00:00.000Z", relevance: "Test requirement" }],
    implementation_strategy: ["Replace the exact file"],
    project_map_hints: ["app.txt"],
  };
  return { root, repo, remote, state, bridgeDirectory, configPath, config, bridge, identity, contract };
}

function implementationFor(jobId: string, runId: string, sources: WebContractEnvelope["sources"]): WebImplementationSubmission {
  const bytes = Buffer.from("after\n");
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: jobId, run_id: runId, contract_only: false, summary: "Replace app.txt", operations: [{ kind: "replace", path: "app.txt", content_base64: bytes.toString("base64"), content_sha256: createHash("sha256").update(bytes).digest("hex") }], project_map: [{ path: "app.txt", purpose: "Requested change" }], sources };
}

async function sealContractAndPrepare(item: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  const counters = { auth: 0, semantic: 0, implementation: 0 };
  injectProviderFakes(item.bridge, { counters, semanticTurns: [{ thread_id: `${suffix}-author-thread`, output: providerEnvelope("contract_sealed", item.contract) }] });
  const contractEvent = await item.bridge.waitForAuthoringEvent(item.identity.job_id, 0);
  assert.equal(contractEvent?.type, "contract_sealed");
  const task = await materializeTaskBundle({ envelope: item.contract, repository: item.contract.repository, config: item.config, stateDirectory: item.state });
  const prepared = await prepareTask({ archivePath: task.archive_path, stateDirectory: item.state, configPath: item.configPath });
  await item.bridge.bindPreparedRun(item.identity.job_id, prepared.run_id, `bind-${suffix}`);
  return { prepared, counters };
}

for (const mode of ["PAIR", "AUTOPILOT"] as const) {
  test(`chatgpt_codex ${mode} authoring, prepared-run binding, implementation and final verdict survive restart`, async () => {
    const item = await fixture(mode);
    const counters = { auth: 0, semantic: 0, implementation: 0 };
    injectProviderFakes(item.bridge, { counters, semanticTurns: [
      { thread_id: `${mode.toLowerCase()}-author-thread`, output: providerEnvelope("repository_command", { operation: "summary" }) },
      { thread_id: `${mode.toLowerCase()}-author-thread`, output: providerEnvelope("contract_sealed", item.contract) },
    ] });
    const repositoryEvent = await item.bridge.waitForAuthoringEvent(item.identity.job_id, 0);
    assert.equal(repositoryEvent?.type, "repository_command");
    assert.deepEqual(repositoryEvent?.type === "repository_command" ? repositoryEvent.command : null, { operation: "summary" });
    await item.bridge.submitRepositoryCommandResult(item.identity.job_id, { request_id: repositoryEvent!.type === "repository_command" ? repositoryEvent!.request_id : "invalid", result: { repository_id: "repo", base_commit: item.contract.repository.base_commit, paths: ["app.txt", "package.json"] } }, `repo-result-${mode}`);
    const contractEvent = await item.bridge.waitForAuthoringEvent(item.identity.job_id, repositoryEvent!.sequence);
    assert.equal(contractEvent?.type, "contract_sealed");
    assert.deepEqual(await item.bridge.receiveSealedContract(item.identity.job_id), item.contract);
    assert.equal(counters.semantic, 2);

    const task = await materializeTaskBundle({ envelope: item.contract, repository: item.contract.repository, config: item.config, stateDirectory: item.state });
    const prepared = await prepareTask({ archivePath: task.archive_path, stateDirectory: item.state, configPath: item.configPath });
    const resumed = createConfiguredWebBridge(item.config, item.bridgeDirectory, process.env, item.state) as ChatGptCodexWebBridge;
    await resumed.bindPreparedRun(item.identity.job_id, prepared.run_id, `bind-${mode}`);
    const submission = implementationFor(item.identity.job_id, prepared.run_id, item.contract.sources);
    injectProviderFakes(resumed, { counters, implementation: submission });
    const implementationEvent = await resumed.waitForAuthoringEvent(item.identity.job_id, contractEvent!.sequence);
    assert.equal(implementationEvent?.type, "implementation_sealed");
    assert.deepEqual(implementationEvent?.type === "implementation_sealed" ? implementationEvent.submission : null, submission);
    assert.equal(counters.implementation, 1);

    const adopted = createConfiguredWebBridge(item.config, item.bridgeDirectory, process.env, item.state) as ChatGptCodexWebBridge;
    assert.equal(await adopted.waitForAuthoringEvent(item.identity.job_id, implementationEvent!.sequence), null);
    assert.deepEqual(await adopted.receiveWebImplementation(item.identity.job_id), submission);
    assert.equal(counters.implementation, 1);

    const resultBundleSha = "b".repeat(64);
    const review = await adopted.createFinalReviewJob({ run_id: prepared.run_id, result_bundle_sha256: resultBundleSha, published_commit_sha: item.contract.repository.base_commit, pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, `review-${mode}`);
    await adopted.submitFinalReviewEvidence(review.job_id, { exact_result: true, run_id: prepared.run_id }, `evidence-${mode}`);
    const verdict: WebVerdictEnvelope = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, review_id: review.job_id, run_id: prepared.run_id, result_bundle_sha256: resultBundleSha, verdict: "APPROVE", summary: "Exact durable evidence satisfies the frozen contract.", findings: [] };
    injectProviderFakes(adopted, { counters, semanticTurns: [{ thread_id: `${mode.toLowerCase()}-review-thread`, output: providerEnvelope("web_verdict", verdict) }] });
    assert.deepEqual(await adopted.waitForVerdict(review.job_id), verdict);
    const semanticAfterVerdict = counters.semantic;
    const finalRestart = createConfiguredWebBridge(item.config, item.bridgeDirectory, process.env, item.state) as ChatGptCodexWebBridge;
    assert.deepEqual(await finalRestart.waitForVerdict(review.job_id), verdict);
    assert.equal(counters.semantic, semanticAfterVerdict);
    assert.equal(counters.auth, 4);
  });
}

test("durable provider turn budget prevents unbounded semantic repository-read loops", async () => {
  const item = await fixture("PAIR");
  item.config.agents.limits.maximum_total_agent_turns = 1;
  const counters = { auth: 0, semantic: 0, implementation: 0 };
  injectProviderFakes(item.bridge, { counters, semanticTurns: [
    { thread_id: "budget-thread", output: providerEnvelope("repository_command", { operation: "summary" }) },
    { thread_id: "budget-thread", output: providerEnvelope("contract_sealed", item.contract) },
  ] });
  const repositoryEvent = await item.bridge.waitForAuthoringEvent(item.identity.job_id, 0);
  assert.equal(repositoryEvent?.type, "repository_command");
  await item.bridge.submitRepositoryCommandResult(item.identity.job_id, { request_id: repositoryEvent!.type === "repository_command" ? repositoryEvent.request_id : "invalid", result: { exact: true } }, "budget-result");
  await assert.rejects(item.bridge.waitForAuthoringEvent(item.identity.job_id, repositoryEvent!.sequence), (error: any) => error?.code === "WEB_CHATGPT_CODEX_BUDGET_EXHAUSTED");
  assert.equal(counters.semantic, 1, "budget exhaustion must happen before a second provider turn");
});

test("implementation auth/preflight failure does not persist an ambiguous provider reservation", async () => {
  const item = await fixture("PAIR");
  const { prepared, counters } = await sealContractAndPrepare(item, "implementation-auth-retry");
  const resumed = createConfiguredWebBridge(item.config, item.bridgeDirectory, process.env, item.state) as ChatGptCodexWebBridge;
  const submission = implementationFor(item.identity.job_id, prepared.run_id, item.contract.sources);
  const target = resumed as any;
  target.ensureAuthorizedForProviderTurn = async () => { throw new Error("auth unavailable before provider boundary"); };
  target.implementation = { async propose() { counters.implementation += 1; return { submission, usage: PROVIDER_USAGE }; } };
  await assert.rejects(() => resumed.receiveWebImplementation(item.identity.job_id), /auth unavailable before provider boundary/);
  assert.equal(counters.implementation, 0);
  injectProviderFakes(resumed, { counters, implementation: submission });
  assert.deepEqual(await resumed.receiveWebImplementation(item.identity.job_id), submission);
  assert.equal(counters.implementation, 1);
});

test("authoring provider failure after reservation is fail-closed and never replayed blindly", async () => {
  const item = await fixture("PAIR"); let providerTurns = 0; const target = item.bridge as any;
  target.ensureAuthorizedForProviderTurn = async () => undefined;
  target.semantic = { async checkAvailability() {}, async turn() { providerTurns += 1; throw new Error("author provider interrupted after reservation"); } };
  await assert.rejects(() => item.bridge.waitForAuthoringEvent(item.identity.job_id, 0), /author provider interrupted after reservation/);
  await assert.rejects(() => item.bridge.waitForAuthoringEvent(item.identity.job_id, 0), /WEB_CHATGPT_CODEX_AMBIGUOUS_AUTHORING|ambiguous contract\/repository decision/i);
  assert.equal(providerTurns, 1);
});

test("implementation provider failure after reservation is fail-closed and never replayed blindly", async () => {
  const item = await fixture("PAIR"); const { prepared } = await sealContractAndPrepare(item, "implementation-provider-crash"); const resumed = createConfiguredWebBridge(item.config, item.bridgeDirectory, process.env, item.state) as ChatGptCodexWebBridge; let providerTurns = 0; const target = resumed as any;
  target.ensureAuthorizedForProviderTurn = async () => undefined;
  target.implementation = { async propose() { providerTurns += 1; throw new Error("implementation provider interrupted after reservation"); } };
  await assert.rejects(() => resumed.receiveWebImplementation(item.identity.job_id), /implementation provider interrupted after reservation/);
  await assert.rejects(() => resumed.receiveWebImplementation(item.identity.job_id), /WEB_CHATGPT_CODEX_AMBIGUOUS_IMPLEMENTATION|ambiguous mutation proposal/i);
  assert.equal(providerTurns, 1); assert.equal(prepared.run_id.length > 64, true);
});

test("final-review provider failure after reservation is fail-closed and never replayed blindly", async () => {
  const item = await fixture("PAIR"); const runId = `FINAL-REVIEW:${"a".repeat(64)}`;
  const review = await item.bridge.createFinalReviewJob({ run_id: runId, result_bundle_sha256: "b".repeat(64), published_commit_sha: item.contract.repository.base_commit, pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, "review-provider-crash");
  await item.bridge.submitFinalReviewEvidence(review.job_id, { exact_result: true, run_id: runId }, "review-provider-crash-evidence");
  let providerTurns = 0; const target = item.bridge as any; target.ensureAuthorizedForProviderTurn = async () => undefined;
  target.semantic = { async checkAvailability() {}, async turn() { providerTurns += 1; throw new Error("review provider interrupted after reservation"); } };
  await assert.rejects(() => item.bridge.waitForVerdict(review.job_id), /review provider interrupted after reservation/);
  await assert.rejects(() => item.bridge.waitForVerdict(review.job_id), /WEB_CHATGPT_CODEX_AMBIGUOUS_REVIEW|ambiguous authority-bearing review/i);
  assert.equal(providerTurns, 1);
});
