import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSemanticChallengeAwareWebBridge, type SemanticChallengeTransport } from "../src/semantic/challenge-aware-web-bridge.js";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { readSemanticChallengeTrajectory } from "../src/semantic/challenge-trajectory-store.js";
import { createConfiguredWebBridge } from "../src/web-bridge/bridge-factory.js";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { ChatGptCodexChallengeWebBridge } from "../src/web-bridge/chatgpt-codex-challenge-bridge.js";
import { contentDigest, WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity } from "../src/web-bridge/contracts.js";

function config(repositoryPath = "/tmp/repo") {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { repo: { path: repositoryPath, remote: "origin", expected_remote_urls: [], fetch_policy: "never" } },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: { maximum_implementation_iterations: 4, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 16, maximum_turn_seconds: 900, maximum_total_seconds: 7_200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 },
    },
  } as any;
}

function challengeIdentity(jobId: string): BridgeJobIdentity {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    owner: "semantic-runtime-test",
    created_at: "2026-08-16T10:00:00.000Z",
    expires_at: "2026-08-16T11:00:00.000Z",
    content_sha256: "a".repeat(64),
  };
}

test("configured local bridge preserves ChatGptCodexWebBridge compatibility while exposing optional challenge capability", () => {
  const bridge = createConfiguredWebBridge(config(), "/tmp/wco-challenge-factory");
  assert.ok(bridge instanceof ChatGptCodexWebBridge);
  assert.ok(bridge instanceof ChatGptCodexChallengeWebBridge);
  assert.equal(isSemanticChallengeAwareWebBridge(bridge), true);
});

test("authoring returns normal authority while a failing blind challenge starts independently and stays fail-open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-challenge-runtime-"));
  try {
    const repositoryPath = path.join(root, "repo");
    const bridgeDirectory = path.join(root, "bridge");
    const stateDirectory = path.join(root, "state");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
    execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"], { cwd: repositoryPath });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
    const bridge = new ChatGptCodexChallengeWebBridge(config(repositoryPath), bridgeDirectory, stateDirectory);

    let providerCreateResolve!: () => void;
    const providerCreated = new Promise<void>((resolve) => { providerCreateResolve = resolve; });
    let providerCreates = 0;
    const fakeTransport: SemanticChallengeTransport = {
      async createSemanticChallengeJob() { providerCreates += 1; providerCreateResolve(); return challengeIdentity("shadow-provider-job"); },
      async waitForSemanticChallengeAction() { return null; },
      async submitSemanticChallengeRepositoryResult() { throw new Error("no repository result expected"); },
      async receiveSemanticUnderstanding() { return null; },
    };
    (bridge as any).challengeProviderPromise = Promise.resolve(fakeTransport);

    const repository = { repository_id: "repo", base_branch: "main", base_commit: baseCommit };
    const goal = "Keep normal authoring authoritative while Web-B reasons independently.";
    const identity = await bridge.createAuthoringJob({ owner: "local", repository, user_intent: goal, ttl_seconds: 86_400 }, "author-runtime-test");
    assert.equal(identity.protocol_version, WEB_BRIDGE_PROTOCOL_VERSION);
    await providerCreated;
    assert.equal(providerCreates, 1);

    const challenge = createSemanticChallengeRequest({
      challengeId: `shadow-${contentDigest({ job_id: identity.job_id, repository, goal }).slice(0, 48)}`,
      repository,
      originalGoal: goal,
    });
    const trajectory = await readSemanticChallengeTrajectory({ stateDirectory, request: challenge });
    assert.deepEqual(trajectory.map((entry) => entry.event_type), ["challenge_created"]);

    const sealed = await bridge.receiveSealedContract(identity.job_id);
    assert.equal(sealed, null, "shadow failure must not invent or mutate normal authoring authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
