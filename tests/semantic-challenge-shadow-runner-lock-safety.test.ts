import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import type { SemanticChallengeTransport } from "../src/semantic/challenge-aware-web-bridge.js";
import { runSemanticChallengeShadow } from "../src/semantic/challenge-shadow-runner.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity } from "../src/web-bridge/contracts.js";

function identity(jobId: string): BridgeJobIdentity {
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: jobId, owner: "semantic-shadow-test", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z", content_sha256: "a".repeat(64) };
}

test("unsafe execution-lock ancestry cannot create outside-state paths or provider jobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-shadow-lock-safety-"));
  try {
    const repositoryPath = path.join(root, "repo");
    const stateDirectory = path.join(root, "state");
    const outside = path.join(root, "outside-lock-target");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(outside);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
    execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"], { cwd: repositoryPath });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
    const request = createSemanticChallengeRequest({ challengeId: "challenge-lock-safety", repository: { repository_id: "repo-lock-safety", base_branch: "main", base_commit: baseCommit }, originalGoal: "Do not traverse unsafe lock ancestry." });
    await symlink(outside, path.join(stateDirectory, "bridge"), process.platform === "win32" ? "junction" : "dir");
    let providerCreates = 0;
    const transport: SemanticChallengeTransport = {
      async createSemanticChallengeJob() { providerCreates += 1; return identity("must-not-create"); },
      async waitForSemanticChallengeAction() { return null; },
      async submitSemanticChallengeRepositoryResult() {},
      async receiveSemanticUnderstanding() { return null; },
    };
    await assert.rejects(runSemanticChallengeShadow({ transport, request, repositoryPath, stateDirectory }), /lock ancestry is unsafe/i);
    assert.equal(providerCreates, 0);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
