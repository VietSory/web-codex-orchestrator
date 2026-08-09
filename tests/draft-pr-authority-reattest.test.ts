import test from "node:test";
import assert from "node:assert/strict";

import { DraftPullRequestStateMachine, type ExecuteDraftPrInput } from "../src/pull-request/draft-pr-service.js";
import { DraftPullRequestError, type DraftPullRequestReceipt, type GitHubPullRequest, type GitHubPullRequestClient } from "../src/pull-request/contracts.js";

const HEAD_SHA = "a".repeat(40);

function exactPullRequest(): GitHubPullRequest {
  return {
    number: 123,
    html_url: "https://github.com/owner/repo/pull/123",
    state: "open",
    draft: true,
    merged_at: null,
    title: "WCO: TASK-1",
    body: null,
    head: {
      ref: "codex/task",
      sha: HEAD_SHA,
      repo: { full_name: "owner/repo" },
    },
    base: {
      ref: "main",
      sha: "d".repeat(40),
      repo: { full_name: "owner/repo" },
    },
  };
}

class MutablePullRequestClient implements GitHubPullRequestClient {
  public current = exactPullRequest();

  async listByHead(): Promise<GitHubPullRequest[]> {
    return [this.current];
  }

  async get(): Promise<GitHubPullRequest> {
    return this.current;
  }

  async createDraft(): Promise<GitHubPullRequest> {
    throw new Error("createDraft must not run in authority re-attestation tests");
  }
}

function baseInput(existingReceipt: DraftPullRequestReceipt | null): ExecuteDraftPrInput {
  return {
    runId: `TASK-1:${"f".repeat(64)}`,
    taskId: "TASK-1",
    owner: "owner",
    repository: "repo",
    baseBranch: "main",
    headBranch: "codex/task",
    expectedHeadSha: HEAD_SHA,
    changeSetSha256: "b".repeat(64),
    gitPublishReceiptSha256: "c".repeat(64),
    existingReceipt,
    verifyRemoteHead: async () => {},
  };
}

async function createOpenFixture(): Promise<{
  client: MutablePullRequestClient;
  receipt: DraftPullRequestReceipt;
  persisted: DraftPullRequestReceipt[];
}> {
  const client = new MutablePullRequestClient();
  const persisted: DraftPullRequestReceipt[] = [];
  const machine = new DraftPullRequestStateMachine(client, async (receipt) => {
    persisted.push(structuredClone(receipt));
  });
  const receipt = await machine.execute(baseInput(null));
  assert.equal(receipt.state, "OPEN");
  assert.equal(receipt.pull_number, 123);
  return { client, receipt, persisted };
}

test("Draft PR retry rejects immutable receipt-field tamper even when stored digests are unchanged", async () => {
  const { client, receipt } = await createOpenFixture();
  const tampered: DraftPullRequestReceipt = { ...receipt, repository_name: "other-repo" };
  const machine = new DraftPullRequestStateMachine(client, async () => {});

  await assert.rejects(
    () => machine.execute(baseInput(tampered)),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_RECEIPT_INCONSISTENT",
  );
});

test("Draft PR OPEN retry does not adopt a tampered PR number that merely points at the same code identity", async () => {
  const { client, receipt, persisted } = await createOpenFixture();
  const tampered: DraftPullRequestReceipt = {
    ...receipt,
    pull_number: 999,
    pull_url: "https://github.com/owner/repo/pull/999",
  };
  const machine = new DraftPullRequestStateMachine(client, async (next) => {
    persisted.push(structuredClone(next));
  });

  const result = await machine.execute(baseInput(tampered));
  assert.equal(result.state, "CONFLICT");
  assert.equal(result.conflict_reason, "OPEN_PR_MUTATED");
  assert.equal(persisted.at(-1)?.state, "CONFLICT");
});

test("Draft PR OPEN retry re-attests the expected head branch, not only its SHA", async () => {
  const { client, receipt, persisted } = await createOpenFixture();
  client.current = {
    ...exactPullRequest(),
    head: {
      ...exactPullRequest().head,
      ref: "other-branch",
    },
  };
  const machine = new DraftPullRequestStateMachine(client, async (next) => {
    persisted.push(structuredClone(next));
  });

  const result = await machine.execute(baseInput(receipt));
  assert.equal(result.state, "CONFLICT");
  assert.equal(result.conflict_reason, "OPEN_PR_MUTATED");
  assert.equal(persisted.at(-1)?.state, "CONFLICT");
});
