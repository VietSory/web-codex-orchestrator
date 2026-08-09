import test from "node:test";
import assert from "node:assert/strict";
import { DraftPullRequestStateMachine, type ExecuteDraftPrInput } from "../src/pull-request/draft-pr-service.js";
import type { GitHubPullRequestClient } from "../src/pull-request/contracts.js";

const input: ExecuteDraftPrInput = {
  runId: `TASK-PR:${"a".repeat(64)}`,
  taskId: "TASK-PR",
  owner: "example",
  repository: "repo",
  baseBranch: "main",
  headBranch: "codex/task-pr",
  expectedHeadSha: "1".repeat(40),
  changeSetSha256: "2".repeat(64),
  gitPublishReceiptSha256: "3".repeat(64),
  existingReceipt: null,
  verifyRemoteHead: async () => {},
};

test("v0.2 Draft PR body presents verified evidence instead of internal phase labels", () => {
  const client = {} as GitHubPullRequestClient;
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as unknown as { getHashes(value: ExecuteDraftPrInput): { title: string; body: string } }).getHashes(input);

  assert.equal(hashes.title, "WCO: TASK-PR");
  assert.match(hashes.body, /## Verified Draft PR/);
  assert.match(hashes.body, /Deterministic verification: \*\*PASS\*\*/);
  assert.match(hashes.body, /Independent Terra review: \*\*PASS\*\*/);
  assert.match(hashes.body, /Independent Sol review: \*\*PASS\*\*/);
  assert.match(hashes.body, /Final merge authority remains with a human maintainer/);
  assert.doesNotMatch(hashes.body, /Phase 4/);
  assert.doesNotMatch(hashes.body, /Phase 5A/);
});
