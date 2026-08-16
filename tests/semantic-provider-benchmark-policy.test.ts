import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";

test("provider benchmark challenger derives its reasoning policy from the runtime blind-challenge prompt", async () => {
  const source = await readFile(path.resolve("scripts/benchmark-semantic-provider.mts"), "utf8");
  assert.match(source, /createSemanticChallengeRequest, semanticChallengePrompt/);
  assert.equal(source.includes("MAINTAINER_REVIEW_STANDARD"), false, "benchmark must not substitute the final-review policy for the runtime blind challenger");
  assert.match(source, /runtime_semanticChallengePrompt_core/);

  const probe = createSemanticChallengeRequest({
    challengeId: "benchmark-policy-probe",
    repository: { repository_id: "benchmark-policy-probe", base_branch: "main", base_commit: "0".repeat(40) },
    originalGoal: "Benchmark policy probe only.",
  });
  const runtime = semanticChallengePrompt(probe);
  for (const text of [
    "You are an independent senior-maintainer semantic challenger.",
    "You have intentionally NOT been shown Web-A's candidate contract",
    "Your task is to independently determine what the repository currently does",
    "Trace relevant callers/callees and state/authority boundaries",
    "Challenge unsupported assumptions.",
  ]) assert.match(runtime, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
