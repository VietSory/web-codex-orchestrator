import test from "node:test";
import assert from "node:assert/strict";
import { DraftPullRequestStateMachine, type ExecuteDraftPrInput } from "../src/pull-request/draft-pr-service.js";
import { DraftPullRequestError, type GitHubPullRequest, type GitHubPullRequestClient, type DraftPullRequestReceipt } from "../src/pull-request/contracts.js";

class FakeGitHubPullRequestClient implements GitHubPullRequestClient {
  public lists: GitHubPullRequest[][] = [];
  public gets: Record<number, GitHubPullRequest> = {};
  public createResult: GitHubPullRequest | Error = new Error("Not implemented");
  public listCalls = 0;
  public getCalls = 0;
  public createCalls = 0;

  async listByHead(input: { owner: string; repository: string; headOwner: string; headBranch: string }): Promise<GitHubPullRequest[]> {
    this.listCalls++;
    const res = this.lists.shift();
    if (res instanceof Error) throw res;
    return res || [];
  }

  async get(input: { owner: string; repository: string; pullNumber: number }): Promise<GitHubPullRequest> {
    this.getCalls++;
    const res = this.gets[input.pullNumber];
    if (!res) throw new DraftPullRequestError("PR_API_NOT_FOUND", "Not found");
    return res;
  }

  async createDraft(input: { owner: string; repository: string; title: string; body: string; head: string; base: string }): Promise<GitHubPullRequest> {
    this.createCalls++;
    if (this.createResult instanceof Error) throw this.createResult;
    return this.createResult;
  }
}

function createDummyInput(overrides: Partial<ExecuteDraftPrInput> = {}): ExecuteDraftPrInput {
  return {
    runId: "run-1",
    taskId: "task-1",
    owner: "foo",
    repository: "bar",
    baseBranch: "main",
    headBranch: "feature",
    expectedHeadSha: "0123456789012345678901234567890123456789",
    changeSetSha256: "a".repeat(64),
    gitPublishReceiptSha256: "b".repeat(64),
    existingReceipt: null,
    verifyRemoteHead: async () => {},
    ...overrides
  };
}

function createCandidate(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 1,
    html_url: "https://github.com/foo/bar/pull/1",
    state: "open",
    draft: true,
    merged_at: null,
    title: "Draft PR",
    body: "Body",
    head: { ref: "feature", sha: "0123456789012345678901234567890123456789", repo: { full_name: "foo/bar" } },
    base: { ref: "main", sha: "1111111111111111111111111111111111111111", repo: { full_name: "foo/bar" } },
    ...overrides
  };
}

function makeOpenReceipt(receipt: DraftPullRequestReceipt, pr: GitHubPullRequest): DraftPullRequestReceipt {
  return {
    ...receipt,
    state: "OPEN",
    pull_number: pr.number,
    pull_url: pr.html_url,
    observed_head_sha: pr.head.sha,
    observed_base_branch: pr.base.ref,
    observed_state: "open",
    observed_draft: true,
    opened_at: "2026-08-09T00:00:00.000Z",
  };
}

test("P5B-008: existing-adoption", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate()]];
  client.gets[1] = createCandidate();
  let persisted: DraftPullRequestReceipt | null = null;
  const machine = new DraftPullRequestStateMachine(client, async (r) => { persisted = r; });
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "OPEN");
  assert.equal(receipt.pull_number, 1);
  assert.equal(client.createCalls, 0);
});

test("P5B-009: existing-conflict (wrong base)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ base: { ref: "wrong", sha: "111", repo: { full_name: "foo/bar" } } })]];
  let persisted: DraftPullRequestReceipt | null = null;
  const machine = new DraftPullRequestStateMachine(client, async (r) => { persisted = r; });
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "WRONG_BASE");
  assert.equal(client.createCalls, 0);
});

test("P5B-010: existing-conflict (wrong head SHA)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ head: { ref: "feature", sha: "wrong", repo: { full_name: "foo/bar" } } })]];
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "WRONG_HEAD_SHA");
});

test("P5B-011: existing-conflict (wrong repository)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ head: { ref: "feature", sha: "0123456789012345678901234567890123456789", repo: { full_name: "wrong/repo" } } })]];
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "WRONG_REPOSITORY");
});

test("P5B-012: existing-conflict (open but not draft)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ draft: false })]];
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "NOT_DRAFT");
});

test("P5B-013: existing-conflict (closed or merged)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ state: "closed" })]];
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  let receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "NOT_OPEN");

  client.lists = [[createCandidate({ merged_at: "2023-01-01T00:00:00Z" })]];
  receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "MERGED");
});

test("P5B-014: existing-conflict (multiple candidates)", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ number: 1 }), createCandidate({ number: 2 })]];
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "MULTIPLE_CANDIDATES");
});

test("P5B-015: pagination", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.listByHead = async () => { throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Simulated pagination"); };
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  await assert.rejects(machine.execute(createDummyInput()), (err: any) => err.code === "PR_API_RESPONSE_INVALID");
  assert.equal(client.createCalls, 0);
});

test("P5B-016: create-happy-path", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], []]; // 1. check candidates -> empty, 2. check candidates after armed -> empty
  client.createResult = createCandidate({ number: 100 });
  client.gets[100] = createCandidate({ number: 100 });
  
  let persistedStates: string[] = [];
  const machine = new DraftPullRequestStateMachine(client, async (r) => { persistedStates.push(r.state); });
  const receipt = await machine.execute(createDummyInput());
  
  assert.equal(receipt.state, "OPEN");
  assert.equal(receipt.pull_number, 100);
  assert.ok(persistedStates.includes("READY_FOR_CREATE"));
  assert.ok(persistedStates.includes("OPEN"));
  assert.equal(client.createCalls, 1);
});

test("P5B-018: write-ahead-crash", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[]]; // check candidate -> none
  let persisted: DraftPullRequestReceipt | null = null;
  const machine = new DraftPullRequestStateMachine(client, async (r) => { persisted = r; });
  
  // existing receipt armed
  const input = createDummyInput();
  const hashes = (machine as any).getHashes(input);
  const existing = (machine as any).createBaseReceipt(input, hashes);
  existing.create_post_attempted = true;
  input.existingReceipt = existing;

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "CREATE_UNCERTAIN");
  assert.equal(client.createCalls, 0);
});

test("P5B-019: ambiguous-timeout", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], []];
  client.createResult = new DraftPullRequestError("PR_CREATE_UNCERTAIN", "Timeout");
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  await assert.rejects(machine.execute(createDummyInput()), (err: any) => err.code === "PR_CREATE_UNCERTAIN");
  assert.equal(client.createCalls, 1);
});

test("P5B-020: ambiguous-5xx", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], []];
  client.createResult = new DraftPullRequestError("PR_API_FAILED", "500 Internal Server Error");
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  await assert.rejects(machine.execute(createDummyInput()), (err: any) => err.code === "PR_API_FAILED");
  assert.equal(client.createCalls, 1);
});

test("P5B-021: uncertain-recovery", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ number: 42 })]]; // list finds exact
  client.gets[42] = createCandidate({ number: 42 });
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  const existing = (machine as any).createBaseReceipt(input, hashes);
  existing.state = "CREATE_UNCERTAIN";
  input.existingReceipt = existing;

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "OPEN");
  assert.equal(receipt.pull_number, 42);
  assert.equal(client.createCalls, 0);
});

test("P5B-022: uncertain-stable", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[]]; // list finds none
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  const existing = (machine as any).createBaseReceipt(input, hashes);
  existing.state = "CREATE_UNCERTAIN";
  input.existingReceipt = existing;

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "CREATE_UNCERTAIN");
  assert.equal(client.createCalls, 0);
});

test("P5B-023: uncertain-conflict", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[createCandidate({ state: "closed" })]]; // conflict
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  const existing = (machine as any).createBaseReceipt(input, hashes);
  existing.state = "CREATE_UNCERTAIN";
  input.existingReceipt = existing;

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(client.createCalls, 0);
});

test("P5B-024: post-success-crash", async () => {
  // Simulate retry with a PR number in CREATE_UNCERTAIN
  const client = new FakeGitHubPullRequestClient();
  client.gets[42] = createCandidate({ number: 42 }); // exact GET
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  const existing = (machine as any).createBaseReceipt(input, hashes);
  existing.state = "CREATE_UNCERTAIN";
  existing.pull_number = 42;
  input.existingReceipt = existing;

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "OPEN");
  assert.equal(client.createCalls, 0);
});

test("P5B-025: post-201-mismatch", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], []]; 
  client.createResult = createCandidate({ number: 99 });
  client.gets[99] = createCandidate({ number: 99, head: { ref: "feature", sha: "moved_sha", repo: { full_name: "foo/bar" } } }); // mismatch
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "WRONG_HEAD_SHA");
});

test("P5B-026: post-201-unverifiable", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], [], []]; 
  client.createResult = createCandidate({ number: 99 });
  // GET throws
  client.get = async () => { throw new DraftPullRequestError("PR_API_RESPONSE_INVALID", "Oversized JSON"); };
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "CREATE_UNCERTAIN");
});

test("P5B-028: 422-recovery", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], [], [createCandidate({ number: 99 })]]; // 1st list empty, 2nd list empty (armed), 3rd list (fallback after 422) returns exact
  client.gets[99] = createCandidate({ number: 99 });
  client.createResult = new DraftPullRequestError("PR_CREATE_REJECTED", "Validation failed");
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const receipt = await machine.execute(createDummyInput());
  assert.equal(receipt.state, "OPEN");
  assert.equal(receipt.pull_number, 99);
});

test("P5B-029: 422-rejected", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], [], []]; // 3rd list returns empty
  client.createResult = new DraftPullRequestError("PR_CREATE_REJECTED", "Validation failed");
  
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  await assert.rejects(machine.execute(createDummyInput()), (err: any) => err.code === "PR_CREATE_REJECTED");
  assert.equal(client.createCalls, 1);
});

test("P5B-030: definitive-auth-retry", async () => {
  const client = new FakeGitHubPullRequestClient();
  client.lists = [[], []];
  client.createResult = new DraftPullRequestError("PR_API_UNAUTHORIZED", "401");
  
  let persistedReceipts: DraftPullRequestReceipt[] = [];
  const machine = new DraftPullRequestStateMachine(client, async (r) => { persistedReceipts.push({...r}); });
  
  await assert.rejects(machine.execute(createDummyInput()), (err: any) => err.code === "PR_API_UNAUTHORIZED");
  // Check that armed flag is reset
  const lastPersist = persistedReceipts[persistedReceipts.length - 1];
  assert.equal(lastPersist?.create_post_attempted, false);
});

test("P5B-031: open-idempotency", async () => {
  const client = new FakeGitHubPullRequestClient();
  const pr = createCandidate({ number: 1 });
  client.gets[1] = pr;
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  input.existingReceipt = makeOpenReceipt((machine as any).createBaseReceipt(input, hashes), pr);

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "OPEN");
  assert.equal(client.listCalls, 0);
  assert.equal(client.createCalls, 0);
  assert.equal(client.getCalls, 1);
});

test("P5B-032: open-mutation", async () => {
  const client = new FakeGitHubPullRequestClient();
  const original = createCandidate({ number: 1 });
  client.gets[1] = createCandidate({ number: 1, state: "closed" }); // mutated
  
  const input = createDummyInput();
  const machine = new DraftPullRequestStateMachine(client, async () => {});
  const hashes = (machine as any).getHashes(input);
  input.existingReceipt = makeOpenReceipt((machine as any).createBaseReceipt(input, hashes), original);

  const receipt = await machine.execute(input);
  assert.equal(receipt.state, "CONFLICT");
  assert.equal(receipt.conflict_reason, "NOT_OPEN");
});
