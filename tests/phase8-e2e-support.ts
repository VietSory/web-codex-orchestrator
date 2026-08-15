import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { packageResultBundle } from "../src/result-bundle/result-bundle-service.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { reviseRun } from "../src/revision/revision-service.js";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { DEFAULT_REVIEWER } from "../src/agent/reviewer-selection.js";
import { freezeRunReviewMode } from "../src/agent/reviewer-mode-store.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import { GitRunner } from "../src/git/git-runner.js";
import { calculateChangeSet } from "../src/execution/change-set.js";
import type { GitPublishReceipt } from "../src/publish/contracts.js";
import { canonicalGitPublishReceiptDigest } from "../src/publish/receipt-digest.js";
import { updateChecksums } from "./helpers/zip-fixture.js";
import { createValidVerdict } from "./helpers/phase7-fixtures.js";

const exec = promisify(execFile);
const TASK_ID = "P8-E2E";
const ARCHIVE_SHA = "1".repeat(64);
const RUN_ID = `${TASK_ID}:${ARCHIVE_SHA}`;
const BRANCH = "codex/p8-e2e";
const REMOTE_URL = "https://github.com/owner/repo";
const PR_NUMBER = 808;

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(stdout).trim();
}

function phase6GitRunner() {
  return {
    async run(args: string[], cwd: string) {
      const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return { stdout: String(stdout) };
    },
    async runBinary(args: string[], cwd: string) {
      const { stdout } = await exec("git", args, { cwd, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return stdout as Buffer;
    },
  };
}

class DynamicGitHubClient implements GitHubAttestationClient {
  constructor(private readonly worktree: string, private readonly baseSha: string) {}
  async getPullRequest(owner: string, repo: string, prNumber: number) {
    const remote = await git(this.worktree, ["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]);
    const headSha = remote.split(/\s+/, 1)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/.test(headSha)) throw new Error("E2E GitHub client could not resolve the remote PR head.");
    const fullName = `${owner}/${repo}`;
    return {
      number: prNumber,
      html_url: `https://github.com/${fullName}/pull/${prNumber}`,
      state: "open",
      draft: true,
      merged: false,
      merged_at: null,
      title: "Phase 8 E2E",
      head: { ref: BRANCH, sha: headSha, repo: { full_name: fullName } },
      base: { ref: "main", sha: this.baseSha, repo: { full_name: fullName } },
    };
  }
}

async function writeTrustedConfig(root: string, repo: string, localRemoteUrl: string): Promise<string> {
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: {
      repo: {
        path: repo,
        remote: "origin",
        expected_remote_urls: [REMOTE_URL, localRemoteUrl],
        fetch_policy: "never",
      },
    },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: {
        maximum_implementation_iterations: 4,
        maximum_internal_review_rounds: 3,
        maximum_sol_review_rounds: 3,
        maximum_total_agent_turns: 12,
        maximum_turn_seconds: 60,
        maximum_total_seconds: 600,
        maximum_total_input_tokens: 100000,
        maximum_total_output_tokens: 100000,
      },
    },
    publish: {
      identity: { name: "WCO Phase8 E2E", email: "wco-phase8@example.invalid" },
      authentication: { mode: "none" },
    },
    verification: {
      allowed_executables: ["npm"],
      allowed_environment_keys: ["CI"],
      maximum_command_seconds: 600,
      maximum_output_bytes: 4194304,
      maximum_file_bytes: 52428800,
      maximum_changed_files: 50,
      maximum_diff_lines: 8000,
      allowed_generated_paths: ["dist/**"],
    },
    github_pull_request: {
      provider: "github.com",
      authentication: { mode: "https_token", token_environment_key: "WCO_GITHUB_TOKEN" },
    },
    result_bundle: {
      maximum_entries: 2000,
      maximum_entry_bytes: 52428800,
      maximum_source_file_bytes: 52428800,
      maximum_diff_bytes: 16777216,
      maximum_total_uncompressed_bytes: 100000000,
      maximum_archive_bytes: 100000000,
      maximum_public_output_bytes_per_command: 1048576,
      maximum_github_response_bytes: 1048576,
      github_attestation: "required",
    },
  }, null, 2));
  return fs.realpath(configPath);
}

async function writeInitialReceipts(params: {
  state: string;
  repo: string;
  accepted: string;
  base: string;
  initialHead: string;
  changeSetSha256: string;
  refsSha256: string;
}): Promise<void> {
  const now = "2026-08-07T12:00:00.000Z";
  const runDir = path.join(params.state, "runs", TASK_ID, ARCHIVE_SHA);
  const executionDir = path.join(runDir, "execution");
  const publishDir = path.join(executionDir, "publish");
  await fs.mkdir(publishDir, { recursive: true });

  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({
    run_version: "1.0",
    run_id: RUN_ID,
    status: "READY_FOR_CODEX",
    task_id: TASK_ID,
    archive_sha256: ARCHIVE_SHA,
    bundle_schema_version: "1.3",
    repository_id: "repo",
    repository_path: params.repo,
    remote: "origin",
    remote_url: REMOTE_URL,
    base_branch: "main",
    base_commit: params.base,
    branch_name: BRANCH,
    worktree_path: params.repo,
    accepted_bundle_path: params.accepted,
    state: "READY_FOR_CODEX",
    checks: ["remote-verified"],
    errors: [],
    created_at: now,
    updated_at: now,
    ready_at: now,
  }, null, 2));

  await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify({
    execution_version: "1.0",
    run_id: RUN_ID,
    state: "READY_FOR_PUBLISH",
    base_commit: params.base,
    branch_name: BRANCH,
    worktree_path: params.repo,
    accepted_bundle_path: params.accepted,
    change_set_sha256: params.changeSetSha256,
    repository_refs_sha256: params.refsSha256,
    implementer: { model: "fixture", reasoning_effort: "high", thread_id: "fixture-impl", iterations: 1 },
    reviewer_selection: DEFAULT_REVIEWER,
    internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high", rounds: 0, latest_thread_id: null, verdict: null, reviewed_change_set_sha256: null },
    final_reviewer: { model: DEFAULT_REVIEWER.model, reasoning_effort: DEFAULT_REVIEWER.reasoning_effort, rounds: 1, latest_thread_id: "fixture-sol", verdict: "APPROVE", reviewed_change_set_sha256: params.changeSetSha256 },
    verification: { rounds: 1, required_commands_passed: true, verified_change_set_sha256: params.changeSetSha256, commands: [] },
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, total_turns: 3, started_at: now },
    errors: [],
    created_at: now,
    updated_at: now,
  }, null, 2));

  const gitPublishReceipt: GitPublishReceipt = {
    publish_version: "1.1",
    run_id: RUN_ID,
    state: "PUSHED",
    base_commit: params.base,
    branch_name: BRANCH,
    remote_name: "origin",
    allowed_remote_url: REMOTE_URL,
    change_set_sha256: params.changeSetSha256,
    expected_paths: ["src/index.ts"],
    approved_snapshot_sha256: params.changeSetSha256,
    commit_sha: params.initialHead,
    remote_branch_sha: params.initialHead,
    created_at: now,
    updated_at: now,
    committed_at: now,
    pushed_at: now,
  };
  const gitPublishBytes = Buffer.from(`${JSON.stringify(gitPublishReceipt, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(publishDir, "git-publish.json"), gitPublishBytes);

  const phase5bDir = path.join(params.state, "publish");
  await fs.mkdir(phase5bDir, { recursive: true });
  await fs.writeFile(path.join(phase5bDir, "github-draft-pr.json"), JSON.stringify({
    receipt_version: "1.0",
    run_id: RUN_ID,
    state: "OPEN",
    repository_owner: "owner",
    repository_name: "repo",
    base_branch: "main",
    head_branch: BRANCH,
    expected_head_sha: params.initialHead,
    git_publish_receipt_sha256: canonicalGitPublishReceiptDigest(gitPublishReceipt),
    request_sha256: sha256Hex("phase8-e2e-request"),
    title: "Phase 8 E2E",
    body_sha256: sha256Hex("phase8-e2e-body"),
    draft_required: true,
    create_post_attempted: true,
    pull_number: PR_NUMBER,
    pull_url: `https://github.com/owner/repo/pull/${PR_NUMBER}`,
    observed_head_sha: params.initialHead,
    observed_base_branch: "main",
    observed_state: "open",
    observed_draft: true,
    conflict_reason: null,
    created_at: now,
    updated_at: now,
    create_attempted_at: now,
    opened_at: now,
    conflict_at: null,
  }, null, 2));
}

function reviewResponse(baseCommit: string, runner: GitRunner) {
  return async (request: AgentTurnRequest) => {
    const changeSet = await calculateChangeSet({
      worktreePath: request.workspace_path,
      baseCommit,
      branchName: BRANCH,
      runner,
      allowedGeneratedPaths: ["dist/**"],
    });
    return {
      verdict: "APPROVE",
      reviewed_change_set_sha256: changeSet.change_set_sha256,
      summary: "Exact revision resolves the sealed finding without scope expansion.",
      acceptance_results: [
        { acceptance_id: "AC-001", status: "PASS", evidence: ["src/index.ts:1"] },
        { acceptance_id: "AC-002", status: "PASS", evidence: ["evidence/verification.json"] },
      ],
      blocking_findings: [],
      non_blocking_findings: [],
      scope_violations: [],
      unverified_acceptance: [],
      human_action: null,
    };
  };
}

test("P8-E2E-001: sealed REVISE becomes a verified same-PR revision bundle and round-2 APPROVE", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-p8-e2e-")));
  try {
    const state = path.join(root, "state");
    const repo = path.join(state, "worktrees", TASK_ID, ARCHIVE_SHA, "repository");
    const bare = path.join(root, "remote.git");
    const localRemoteUrl = pathToFileURL(bare).href;
    const accepted = path.join(state, "accepted", TASK_ID, ARCHIVE_SHA);
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(state, { recursive: true });
    await exec("git", ["init", "--bare", bare]);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Phase 8 E2E"]);
    await git(repo, ["config", "user.email", "phase8-e2e@example.invalid"]);
    await git(repo, ["config", `url.${localRemoteUrl}.insteadOf`, REMOTE_URL]);
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "index.ts"), "export const status = 'base';\n");
    await git(repo, ["add", "src/index.ts"]);
    await git(repo, ["commit", "-m", "base"]);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["remote", "add", "origin", REMOTE_URL]);
    await git(repo, ["push", "-u", "origin", "main"]);
    await git(repo, ["checkout", "-b", BRANCH]);
    await fs.writeFile(path.join(repo, "src", "index.ts"), "export const status = 'buggy';\n");
    await git(repo, ["add", "src/index.ts"]);
    await git(repo, ["commit", "-m", "initial product commit"]);
    const initialHead = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["push", "-u", "origin", BRANCH]);

    await fs.cp(path.resolve("templates/task-bundle"), accepted, { recursive: true });
    const manifestPath = path.join(accepted, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.task_id = TASK_ID;
    const repository = manifest.repository as Record<string, unknown>;
    repository.id = "repo";
    repository.base_branch = "main";
    repository.base_commit = base;
    const delivery = manifest.delivery as Record<string, unknown>;
    delivery.remote = "origin";
    delivery.base_branch = "main";
    delivery.branch_name = BRANCH;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(accepted);

    const configPath = await writeTrustedConfig(root, repo, localRemoteUrl);
    const runner = new GitRunner();
    const initialChangeSetSha256 = sha256Hex(`initial-change:${base}:${initialHead}`);
    const initialRefsSha256 = sha256Hex(`initial-refs:${BRANCH}:${initialHead}`);
    await writeInitialReceipts({ state, repo, accepted, base, initialHead, changeSetSha256: initialChangeSetSha256, refsSha256: initialRefsSha256 });
    await freezeRunReviewMode(state, RUN_ID, DEFAULT_REVIEWER, () => new Date("2026-08-07T12:00:00.000Z"));

    const githubClient = new DynamicGitHubClient(repo, base);
    const initialBundle = await packageResultBundle({
      runId: RUN_ID,
      stateDirectory: state,
      configPath,
      githubClient,
      gitRunner: phase6GitRunner(),
      now: () => new Date("2026-08-07T12:10:00.000Z"),
    });
    assert.equal(initialBundle.result_bundle_version, "1.1");
    assert.equal(initialBundle.published_commit_sha, initialHead);

    const round1VerdictPath = path.join(root, "round1-revise.json");
    const round1Verdict = createValidVerdict(initialBundle, {
      verdict: "REVISE",
      summary: "AC-001 requires a bounded implementation correction.",
      comprehensive_review_complete: true,
      criterion_results: [
        { criterion_id: "AC-001", required: true, status: "FAIL", evidence_refs: ["repository/source/src/index.ts"], notes: "Status is buggy." },
        { criterion_id: "AC-002", required: true, status: "PASS", evidence_refs: ["evidence/verification.json"], notes: "Verification remains green." },
      ],
      blocking_findings: [{
        finding_id: "WEB-FIND-001",
        classification: "IMPLEMENTATION_DEFECT",
        finding_origin: "INITIAL_DISCOVERY",
        previous_finding_id: null,
        locked_reference_ids: ["AC-001"],
        artifact_paths: ["repository/source/src/index.ts"],
        line_or_json_pointer: "1",
        expected_behavior: "The implementation must satisfy AC-001.",
        observed_behavior: "The current status remains buggy.",
        evidence: "repository/source/src/index.ts:1",
        minimal_required_fix: "Correct src/index.ts without changing the frozen contract.",
        revision_changed_paths: [],
      }],
    });
    await fs.writeFile(round1VerdictPath, JSON.stringify(round1Verdict, null, 2));
    const round1Receipt = await submitWebVerdict({ runId: RUN_ID, stateDirectory: state, configPath, verdictPath: round1VerdictPath, githubClient });
    assert.equal(round1Receipt.state, "REVISION_REQUESTED");
    assert.ok(round1Receipt.verdict_sha256);
    assert.ok(round1Receipt.revision_request_sha256);

    const review = reviewResponse(initialHead, runner);
    const agent = new FakeAgentClient([
      {
        status: "COMPATIBLE",
        summary: "The sealed finding can be fixed inside the frozen contract.",
        repository_observations: [],
        bundle_conflicts: [],
        missing_prerequisites: [],
        human_action: null,
      },
      async (request: AgentTurnRequest) => {
        await fs.writeFile(path.join(request.workspace_path, "src", "index.ts"), "export const status = 'fixed';\n");
        return {
          status: "READY_FOR_VERIFICATION",
          summary: "Fixed the sealed implementation defect.",
          changed_files_claimed: ["src/index.ts"],
          acceptance_evidence: [
            { acceptance_id: "AC-001", status: "implemented", evidence: ["src/index.ts:1"], notes: "Status is fixed." },
            { acceptance_id: "AC-002", status: "implemented", evidence: ["src/index.ts:1"], notes: "No contract change." },
          ],
          tests_added_or_changed: [],
          unresolved_issues: [],
          human_action: null,
        };
      },
      review,
    ]);
    const sandbox = new FakeVerificationSandbox();

    const revision = await reviseRun({
      runId: RUN_ID,
      revisionRound: 1,
      stateDirectory: state,
      configPath,
      agentClient: agent,
      sandbox,
      gitRunner: runner,
      githubClient,
      now: () => new Date("2026-08-07T12:20:00.000Z"),
    });
    assert.equal(revision.state, "RESULT_READY");
    assert.equal(revision.branch_name, BRANCH);
    assert.equal(revision.pull_request_number, PR_NUMBER);
    assert.ok(revision.new_published_commit_sha);
    assert.notEqual(revision.new_published_commit_sha, initialHead);
    assert.equal(revision.new_published_commit_sha, revision.remote_branch_sha);
    const internalReviewerCalls = agent.calls.filter((call) => call.role === "internal_reviewer");
    const finalReviewerCalls = agent.calls.filter((call) => call.role === "final_reviewer");
    assert.equal(internalReviewerCalls.length, 0, "Sol-selected Phase 8 must never call Terra reviewer");
    assert.equal(finalReviewerCalls.length, 1, "Sol-selected Phase 8 must call only the frozen Sol reviewer");
    assert.equal(finalReviewerCalls[0]?.model, DEFAULT_REVIEWER.model);
    assert.equal(finalReviewerCalls[0]?.reasoning_effort, DEFAULT_REVIEWER.reasoning_effort);
    assert.equal(revision.terra_review.rounds, 0);
    assert.equal(revision.terra_review.verdict, null);
    assert.equal(revision.terra_review.reviewed_change_set_sha256, null);
    assert.equal(revision.sol_review.rounds, 1);
    assert.equal(revision.sol_review.verdict, "APPROVE");
    assert.equal(revision.sol_review.reviewed_change_set_sha256, revision.verification.verified_change_set_sha256);
    assert.equal(await git(repo, ["rev-list", "--count", `${initialHead}..${revision.new_published_commit_sha}`]), "1");
    assert.equal(await git(repo, ["rev-parse", `${revision.new_published_commit_sha}^`]), initialHead);
    const remoteRow = await git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]);
    assert.equal(remoteRow.split(/\s+/)[0], revision.new_published_commit_sha);

    const round2Bundle = await loadAndVerifyResultBundle(state, RUN_ID, 2);
    assert.equal(round2Bundle.receipt.result_bundle_version, "1.2");
    assert.equal(round2Bundle.receipt.input_kind, "revision");
    assert.equal(round2Bundle.receipt.revision_round, 1);
    assert.equal(round2Bundle.receipt.previous_result_bundle_sha256, initialBundle.archive_sha256);
    assert.equal(round2Bundle.receipt.previous_verdict_sha256, round1Receipt.verdict_sha256);
    assert.equal(round2Bundle.receipt.previous_pr_head_sha, initialHead);
    assert.equal(round2Bundle.receipt.published_commit_sha, revision.new_published_commit_sha);
    assert.ok(round2Bundle.bundleEntries.has("revision/diff.patch"));
    assert.ok(round2Bundle.bundleEntries.has("repository/diff.patch"));

    const round2VerdictPath = path.join(root, "round2-approve.json");
    const round2Verdict = createValidVerdict(round2Bundle.receipt, {
      review_mode: "REVISION",
      review_round: 2,
      previous_result_bundle_sha256: initialBundle.archive_sha256!,
      previous_verdict_sha256: round1Receipt.verdict_sha256!,
      previous_published_commit_sha: initialHead,
      revision_request_sha256: round1Receipt.revision_request_sha256!,
      verdict: "APPROVE",
      summary: "The sealed finding is resolved and the frozen contract remains satisfied.",
      comprehensive_review_complete: true,
      criterion_results: [
        { criterion_id: "AC-001", required: true, status: "PASS", evidence_refs: ["revision/source/src/index.ts"], notes: "The correction is present." },
        { criterion_id: "AC-002", required: true, status: "PASS", evidence_refs: ["evidence/verification.json"], notes: "Required verification passed." },
      ],
      blocking_findings: [],
      non_blocking_backlog: [],
    });
    await fs.writeFile(round2VerdictPath, JSON.stringify(round2Verdict, null, 2));
    const round2Receipt = await submitWebVerdict({ runId: RUN_ID, stateDirectory: state, configPath, verdictPath: round2VerdictPath, githubClient });
    assert.equal(round2Receipt.state, "APPROVED");
    assert.equal(round2Receipt.action, "ASK_USER_TO_MERGE");
    assert.equal(round2Receipt.review_round, 2);
    assert.equal(round2Receipt.fresh_attested_head_sha, revision.new_published_commit_sha);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
