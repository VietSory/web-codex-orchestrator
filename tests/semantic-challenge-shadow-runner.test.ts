import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest, type SemanticUnderstandingEnvelope } from "../src/semantic/blind-challenge.js";
import type { SemanticChallengeRemoteAction, SemanticChallengeTransport } from "../src/semantic/challenge-aware-web-bridge.js";
import { runSemanticChallengeShadow, runSemanticChallengeShadowIfSupported } from "../src/semantic/challenge-shadow-runner.js";
import { appendSemanticChallengeTrajectoryEvent, readSemanticChallengeTrajectory } from "../src/semantic/challenge-trajectory-store.js";
import { contentDigest, WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity, type RepositoryCommandResult } from "../src/web-bridge/contracts.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-shadow-challenge-runner-"));
  const repositoryPath = path.join(root, "repo");
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(repositoryPath, "src"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(repositoryPath, "src", "focus.ts"), "export const currentFocus = 'active';\n", "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: repositoryPath });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
  const request = createSemanticChallengeRequest({
    challengeId: "challenge-shadow-runner",
    repository: { repository_id: "repo-shadow", base_branch: "main", base_commit: baseCommit },
    originalGoal: "Preserve current focus while changing resume behavior.",
  });
  return { root, repositoryPath, stateDirectory, request };
}

function identity(jobId: string): BridgeJobIdentity {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: jobId,
    owner: "semantic-shadow-test",
    created_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T01:00:00.000Z",
    content_sha256: "a".repeat(64),
  };
}

class EvidenceDrivenTransport implements SemanticChallengeTransport {
  private delivered: RepositoryCommandResult | null = null;
  private sealed: SemanticUnderstandingEnvelope | null = null;
  deliveredRequestId: string | null = null;

  constructor(private readonly request: ReturnType<typeof createSemanticChallengeRequest>) {}
  async createSemanticChallengeJob() { return identity("shadow-job-001"); }
  async waitForSemanticChallengeAction(_jobId: string, afterSequence: number): Promise<SemanticChallengeRemoteAction | null> {
    if (afterSequence === 0) return { sequence: 1, type: "repository_command", request_id: "remote-read", command: { operation: "read", paths: ["src/focus.ts"] } };
    if (afterSequence !== 1 || !this.delivered) return null;
    const result = this.delivered.result;
    if (result.kind !== "read") throw new Error("expected read result");
    const file = result.files[0]!;
    const citation = { path: file.path, content_sha256: file.content_sha256, start_byte: file.start_byte, end_byte_exclusive: file.end_byte_exclusive };
    this.sealed = {
      schema_version: "1.0",
      kind: "semantic_understanding_sealed",
      challenge_id: this.request.challenge_id,
      repository: this.request.repository,
      original_goal_sha256: contentDigest(this.request.original_goal),
      findings: [
        { finding_id: "component-focus", category: "component", statement: "The current-focus module is directly relevant.", citations: [citation] },
        { finding_id: "invariant-focus", category: "invariant", statement: "Current focus must remain explicit rather than silently switching.", citations: [citation] },
        { finding_id: "risk-focus", category: "risk", statement: "Implicit focus replacement can mutate the wrong task.", citations: [citation] },
      ],
      unresolved_questions: [],
    };
    return { sequence: 2, type: "semantic_understanding_sealed", envelope: this.sealed };
  }
  async submitSemanticChallengeRepositoryResult(_jobId: string, result: RepositoryCommandResult) { this.deliveredRequestId = result.request_id; this.delivered = structuredClone(result); }
  async receiveSemanticUnderstanding() { return this.sealed ? structuredClone(this.sealed) : null; }
}

test("shadow runner owns repository evidence, preserves remote request identity, validates understanding, and persists digest trajectory", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  const transport = new EvidenceDrivenTransport(value.request);
  const result = await runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory });
  assert.equal(transport.deliveredRequestId, "remote-read", "transport correlation must use Web-B's request identity, not the private evidence request ID");
  assert.equal(result.repository_observations, 1);
  assert.equal(result.remote_actions, 2);
  assert.equal(result.trajectory_events, 3);
  assert.deepEqual(result.understanding.findings.map((finding) => finding.category), ["component", "invariant", "risk"]);
  const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: value.stateDirectory, request: value.request });
  assert.deepEqual(trajectory.map((receipt) => receipt.event_type), ["challenge_created", "repository_observation", "understanding_sealed"]);
});

test("shadow runner requires contiguous remote action sequences before repository mutation", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  const transport: SemanticChallengeTransport = {
    async createSemanticChallengeJob() { return identity("bad-sequence-job"); },
    async waitForSemanticChallengeAction() { return { sequence: 2, type: "repository_command", request_id: "bad", command: { operation: "summary" } }; },
    async submitSemanticChallengeRepositoryResult() { throw new Error("must not submit"); },
    async receiveSemanticUnderstanding() { return null; },
  };
  await assert.rejects(runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory }), /sequence must be contiguous/i);
  const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: value.stateDirectory, request: value.request });
  assert.deepEqual(trajectory.map((receipt) => receipt.event_type), ["challenge_created"]);
});

test("shadow runner rejects reused remote request identity before a second repository read", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  let calls = 0;
  const transport: SemanticChallengeTransport = {
    async createSemanticChallengeJob() { return identity("duplicate-request-job"); },
    async waitForSemanticChallengeAction(_jobId, afterSequence) {
      calls += 1;
      if (afterSequence === 0) return { sequence: 1, type: "repository_command", request_id: "same-read", command: { operation: "summary" } };
      return { sequence: 2, type: "repository_command", request_id: "same-read", command: { operation: "summary" } };
    },
    async submitSemanticChallengeRepositoryResult() {},
    async receiveSemanticUnderstanding() { return null; },
  };
  await assert.rejects(runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory }), /request identity was reused/i);
  assert.equal(calls, 2);
  const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: value.stateDirectory, request: value.request });
  assert.deepEqual(trajectory.map((receipt) => receipt.event_type), ["challenge_created", "repository_observation"]);
});

test("partial digest-only trajectory fails closed instead of pretending provider/evidence replay is exact", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory: value.stateDirectory, request: value.request, sequence: 1, eventType: "challenge_created", idempotencyKey: "challenge-created", payload: { request_sha256: contentDigest(value.request) } });
  let created = false;
  const transport: SemanticChallengeTransport = {
    async createSemanticChallengeJob() { created = true; return identity("must-not-create"); },
    async waitForSemanticChallengeAction() { return null; },
    async submitSemanticChallengeRepositoryResult() {},
    async receiveSemanticUnderstanding() { return null; },
  };
  await assert.rejects(runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory }), /cannot replay a prior trajectory/i);
  assert.equal(created, false, "no external/provider work may begin after an unreconstructable partial trajectory");
});

test("ordinary WebBridge does not opt into semantic shadow challenge authority", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  const ordinary = {
    async createAuthoringJob() { throw new Error("unused"); },
    async waitForAuthoringEvent() { return null; },
    async submitRepositoryCommandResult() {},
    async submitClarification() {},
    async receiveSealedContract() { return null; },
    async receiveWebImplementation() { return null; },
    async createFinalReviewJob() { throw new Error("unused"); },
    async submitFinalReviewEvidence() {},
    async waitForVerdict() { return null; },
    async getConnectionStatus() { return { configured: true, connected: true }; },
  } as WebBridge;
  assert.equal(await runSemanticChallengeShadowIfSupported({ bridge: ordinary, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory }), null);
});
