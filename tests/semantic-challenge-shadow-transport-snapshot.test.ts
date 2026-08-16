import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest, type SemanticChallengeRequest, type SemanticUnderstandingEnvelope } from "../src/semantic/blind-challenge.js";
import type { SemanticChallengeRemoteAction, SemanticChallengeTransport } from "../src/semantic/challenge-aware-web-bridge.js";
import { runSemanticChallengeShadow } from "../src/semantic/challenge-shadow-runner.js";
import { contentDigest, WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity, type RepositoryCommandResult } from "../src/web-bridge/contracts.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-shadow-transport-snapshot-"));
  const repositoryPath = path.join(root, "repo");
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(repositoryPath, "src"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(repositoryPath, "src", "focus.ts"), "export const focus = 'stable';\n", "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: repositoryPath });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
  const request = createSemanticChallengeRequest({
    challengeId: "challenge-transport-snapshot",
    repository: { repository_id: "repo-transport-snapshot", base_branch: "main", base_commit: baseCommit },
    originalGoal: "Keep transport-owned mutations outside challenge provenance.",
  });
  return { root, repositoryPath, stateDirectory, request };
}

function identity(jobId: string): BridgeJobIdentity {
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: jobId, owner: "semantic-shadow-test", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z", content_sha256: "a".repeat(64) };
}

function understanding(request: SemanticChallengeRequest, delivered: RepositoryCommandResult): SemanticUnderstandingEnvelope {
  const raw = delivered.result as { files?: Array<{ path?: unknown; content_sha256?: unknown; start_byte?: unknown; end_byte_exclusive?: unknown }> };
  const file = raw.files?.[0];
  if (!file || typeof file.path !== "string" || typeof file.content_sha256 !== "string" || !Number.isSafeInteger(file.start_byte) || !Number.isSafeInteger(file.end_byte_exclusive)) throw new Error("expected exact read result");
  const citation = { path: file.path, content_sha256: file.content_sha256, start_byte: file.start_byte as number, end_byte_exclusive: file.end_byte_exclusive as number };
  return {
    schema_version: "1.0",
    kind: "semantic_understanding_sealed",
    challenge_id: request.challenge_id,
    repository: structuredClone(request.repository),
    original_goal_sha256: contentDigest(request.original_goal),
    findings: [
      { finding_id: "component-focus", category: "component", statement: "The focus module is relevant.", citations: [citation] },
      { finding_id: "invariant-focus", category: "invariant", statement: "Stable focus must remain explicit.", citations: [citation] },
      { finding_id: "risk-focus", category: "risk", statement: "Transport mutation could otherwise redirect evidence.", citations: [citation] },
    ],
    unresolved_questions: [],
  };
}

test("transport cannot mutate the runner's private challenge request", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  let delivered: RepositoryCommandResult | null = null;
  let sealed: SemanticUnderstandingEnvelope | null = null;
  const transport: SemanticChallengeTransport = {
    async createSemanticChallengeJob(request) {
      request.challenge_id = "transport-mutated-challenge";
      request.repository.base_branch = "transport-mutated-branch";
      request.original_goal = "transport-mutated-goal";
      return identity("stable-job");
    },
    async waitForSemanticChallengeAction(_jobId, afterSequence): Promise<SemanticChallengeRemoteAction | null> {
      if (afterSequence === 0) return { sequence: 1, type: "repository_command", request_id: "remote-read", command: { operation: "read", paths: ["src/focus.ts"] } };
      if (!delivered) return null;
      sealed = understanding(value.request, delivered);
      return { sequence: 2, type: "semantic_understanding_sealed", envelope: sealed };
    },
    async submitSemanticChallengeRepositoryResult(_jobId, result) { delivered = structuredClone(result); },
    async receiveSemanticUnderstanding() { return sealed ? structuredClone(sealed) : null; },
  };
  const result = await runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory });
  assert.equal(result.challenge_id, value.request.challenge_id);
  assert.equal(result.understanding.challenge_id, value.request.challenge_id);
  assert.equal(result.understanding.repository.base_branch, "main");
});

test("job identity and remote actions are snapshotted before transport-owned mutation crosses await boundaries", async (t) => {
  const value = await fixture();
  t.after(async () => { await rm(value.root, { recursive: true, force: true }); });
  const returnedIdentity = identity("stable-job");
  const observedJobIds: string[] = [];
  let delivered: RepositoryCommandResult | null = null;
  let deliveredRequestId: string | null = null;
  let sealed: SemanticUnderstandingEnvelope | null = null;
  const transport: SemanticChallengeTransport = {
    async createSemanticChallengeJob() { return returnedIdentity; },
    async waitForSemanticChallengeAction(jobId, afterSequence): Promise<SemanticChallengeRemoteAction | null> {
      observedJobIds.push(jobId);
      if (afterSequence === 0) {
        returnedIdentity.job_id = "transport-mutated-job";
        const action: Extract<SemanticChallengeRemoteAction, { type: "repository_command" }> = {
          sequence: 1,
          type: "repository_command",
          request_id: "remote-read",
          command: { operation: "read", paths: ["src/focus.ts"] },
        };
        setImmediate(() => { action.request_id = "transport-mutated-read"; });
        return action;
      }
      if (!delivered) return null;
      sealed = understanding(value.request, delivered);
      const action: Extract<SemanticChallengeRemoteAction, { type: "semantic_understanding_sealed" }> = { sequence: 2, type: "semantic_understanding_sealed", envelope: sealed };
      setImmediate(() => { action.envelope.challenge_id = "transport-mutated-seal"; });
      return action;
    },
    async submitSemanticChallengeRepositoryResult(jobId, result) {
      observedJobIds.push(jobId);
      deliveredRequestId = result.request_id;
      delivered = structuredClone(result);
    },
    async receiveSemanticUnderstanding(jobId) {
      observedJobIds.push(jobId);
      return sealed ? structuredClone(sealed) : null;
    },
  };
  const result = await runSemanticChallengeShadow({ transport, request: value.request, repositoryPath: value.repositoryPath, stateDirectory: value.stateDirectory });
  assert.equal(result.job_id, "stable-job");
  assert.equal(deliveredRequestId, "remote-read");
  assert.deepEqual(new Set(observedJobIds), new Set(["stable-job"]));
  assert.equal(result.understanding.challenge_id, value.request.challenge_id);
});
