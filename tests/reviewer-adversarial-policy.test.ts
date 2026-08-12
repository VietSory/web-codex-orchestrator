import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../src/agent/contracts.js";
import { reviewWithSol } from "../src/agent/sol-reviewer.js";
import { reviewWithTerra } from "../src/agent/terra-reviewer.js";
import { validateReviewFindings } from "../src/agent/output-validator.js";

const DIGEST = "a".repeat(64);
const APPROVAL = {
  verdict: "APPROVE",
  reviewed_change_set_sha256: DIGEST,
  summary: "No blocking defect found after adversarial diff review.",
  acceptance_results: [],
  blocking_findings: [],
  non_blocking_findings: [],
  scope_violations: [],
  unverified_acceptance: [],
  human_action: null,
  repair_operations: [],
};

class CaptureClient implements AgentClient {
  readonly requests: AgentTurnRequest[] = [];
  constructor(private readonly output: unknown = APPROVAL) {}

  async checkAvailability(): Promise<void> {}

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.requests.push(request);
    return { thread_id: `review-thread-${this.requests.length}`, output: this.output };
  }
}

const request = {
  model: "review-model",
  reasoning_effort: "high" as const,
  prompt: `Base commit: ${"b".repeat(40)}\nChange-set digest: ${DIGEST}\nBounded tracked diff:\n@@ -1 +1 @@\n-old\n+new\nDeterministic verification evidence: PASS`,
  threadId: undefined,
  workspacePath: "/tmp/wco-reviewer-policy-test-workspace-that-must-not-exist",
  acceptedBundlePath: "/tmp/review-bundle",
  deletedPaths: [] as string[],
};

function finding(file: string) {
  return {
    id: "FINDING-1",
    severity: "medium",
    category: "maintainability",
    file,
    line_start: 1,
    line_end: 1,
    acceptance_ids: [],
    problem: "Concrete review evidence must resolve to the exact worktree or a deleted diff path.",
    evidence: `${file}:1`,
    required_fix: "Use exact review evidence.",
  };
}

function assertSeniorPolicy(prompt: string): void {
  assert.match(prompt, /senior maintainer performing an adversarial pull-request review/i);
  assert.match(prompt, /verification passing is a prerequisite.*not proof/i);
  assert.match(prompt, /complete diff against the supplied base commit/i);
  assert.match(prompt, /every changed file and every diff hunk/i);
  assert.match(prompt, /concurrency, races, retries, replay and idempotency/i);
  assert.match(prompt, /crash\/restart recovery and stale state/i);
  assert.match(prompt, /Do not trust implementation claims.*green test suite as correctness evidence/i);
  assert.match(prompt, /APPROVE only after the complete diff has been inspected/i);
  assert.match(prompt, /repair_operations in the same response/i);
  assert.match(prompt, /If the complete diff cannot be inspected.*do not APPROVE/i);
}

test("selected Sol reviewer receives senior adversarial diff-review policy", async () => {
  const client = new CaptureClient();
  await reviewWithSol(client, request);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]!.read_only, true);
  assert.equal(client.requests[0]!.sandbox_mode, "read-only");
  assert.equal(client.requests[0]!.approval_policy, "never");
  assert.equal(client.requests[0]!.network_access, false);
  assertSeniorPolicy(client.requests[0]!.prompt);
});

test("selected Terra reviewer receives the same senior adversarial diff-review policy", async () => {
  const client = new CaptureClient();
  await reviewWithTerra(client, request);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]!.read_only, true);
  assert.equal(client.requests[0]!.sandbox_mode, "read-only");
  assert.equal(client.requests[0]!.approval_policy, "never");
  assert.equal(client.requests[0]!.network_access, false);
  assertSeniorPolicy(client.requests[0]!.prompt);
});

test("reviewer approval is rejected when its own structured evidence contains a blocker", async () => {
  const client = new CaptureClient({
    ...APPROVAL,
    blocking_findings: [{
      ...finding("src/example.ts"),
      id: "BLOCK-1",
      severity: "high",
      category: "correctness",
      problem: "The patch can return the wrong result.",
      required_fix: "Correct the branch before approval.",
    }],
  });
  await assert.rejects(reviewWithSol(client, request), /APPROVE cannot carry blocking findings/);
});

test("reviewer approval is rejected when reported acceptance is failed or unverified", async () => {
  const client = new CaptureClient({
    ...APPROVAL,
    acceptance_results: [{ acceptance_id: "AC-1", status: "FAIL", evidence: ["tests/example.test.ts:1"] }],
  });
  await assert.rejects(reviewWithTerra(client, request), /APPROVE requires all reported acceptance evidence to be PASS/);
});

test("reviewer approval is rejected for each contradictory authority field", async () => {
  const contradictions = [
    { patch: { scope_violations: ["outside frozen scope"] }, expected: /scope violations/ },
    { patch: { unverified_acceptance: ["AC-1"] }, expected: /fully verified/ },
    { patch: { human_action: { category: "other", description: "decide", requested_capability: "human choice" } }, expected: /human action/ },
    { patch: { repair_operations: [{ op_id: "repair-1", kind: "delete_file", path: "src/example.ts", preimage_sha256: DIGEST, postimage_base64: null, postimage_sha256: null }] }, expected: /Only REVISE may carry repair operations|repair operations/ },
  ];
  for (const contradiction of contradictions) {
    const client = new CaptureClient({ ...APPROVAL, ...contradiction.patch });
    await assert.rejects(reviewWithSol(client, request), contradiction.expected);
  }
});

test("REVISE without a concrete blocker is rejected", async () => {
  const client = new CaptureClient({ ...APPROVAL, verdict: "REVISE" });
  await assert.rejects(reviewWithTerra(client, request), /REVISE requires at least one concrete blocking finding/);
});

test("review findings cannot cite an invented path outside the exact changed set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-invented-"));
  try {
    const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding("src/does-not-exist.ts")] });
    await assert.rejects(reviewWithSol(client, { ...request, workspacePath: root }), /does not exist and is not an exact deleted\/renamed-away path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing changed path is rejected unless exact authority says it was deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-created-"));
  try {
    const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding("src/new-file.ts")] });
    await assert.rejects(reviewWithSol(client, { ...request, workspacePath: root, deletedPaths: [] }), /not an exact deleted\/renamed-away path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a finding may cite an exact deleted diff path through both review validators", async () => {
  const deletedPath = "src/deleted.ts";
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-deleted-"));
  try {
    const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding(deletedPath)] });
    const result = await reviewWithTerra(client, { ...request, workspacePath: root, deletedPaths: [deletedPath] });
    assert.equal(result.review.non_blocking_findings[0]!.file, deletedPath);
    await validateReviewFindings(result.review, root, "TERRA_REVIEW_OUTPUT_INVALID", [deletedPath]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("finding paths reject traversal, leaf symlinks, symlinked ancestors, and out-of-range lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-policy-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-review-outside-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "one-line.ts"), "export const value = 1;\n");
    await writeFile(path.join(outside, "secret.ts"), "do not read\n");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "leaf.ts"));
    await symlink(outside, path.join(root, "linked"));

    const cases = [
      { file: "../outside.ts", expected: /Invalid reviewer output|escapes the worktree/ },
      { file: "src/leaf.ts", expected: /canonical worktree directories|non-symlink/ },
      { file: "linked/secret.ts", expected: /canonical worktree directories/ },
    ];
    for (const item of cases) {
      const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [finding(item.file)] });
      await assert.rejects(reviewWithSol(client, { ...request, workspacePath: root }), item.expected);
    }

    const client = new CaptureClient({ ...APPROVAL, non_blocking_findings: [{ ...finding("src/one-line.ts"), line_start: 2, line_end: 2 }] });
    await assert.rejects(reviewWithTerra(client, { ...request, workspacePath: root }), /outside the reviewed file/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
