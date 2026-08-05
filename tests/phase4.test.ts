import { strict as assert } from "node:assert";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateBundleDirectory } from "../src/bundle/validator.js";
import { validateConfig } from "../src/config/config-validator.js";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import { validateAssessment, validateImplementation, validateReview } from "../src/agent/output-validator.js";
import { assertPhase4ExecutionContract, validatePhase4ExecutionContract } from "../src/execution/execution-validator.js";
import { assertTransition, canTransition } from "../src/execution/state-machine.js";
import { enforcePathPolicy } from "../src/execution/path-policy.js";
import { calculateChangeSet } from "../src/execution/change-set.js";
import { ExecutionError } from "../src/execution/errors.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import { CodexVerificationSandbox } from "../src/verifier/codex-sandbox.js";
import { validateArguments, validateExecutable } from "../src/verifier/executable-policy.js";
import { validateEnvironment } from "../src/verifier/environment-policy.js";
import { validateStructuredValidationContract } from "../src/verifier/validation-contract.js";
import { assertReadyForPublish, assertSolCanStart, assertTerraCanStart } from "../src/execution/review-gates.js";
import type { ExecutionReceipt, ReviewResult } from "../src/execution/contracts.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { updateChecksums } from "./helpers/zip-fixture.js";
import { executeRun } from "../src/execution/execution-service.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { fakeResolvedCodexRuntime } from "./helpers/codex-runtime-fixture.js";

function expectCode(action: () => unknown | Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(async () => await action(), (error: unknown) => error instanceof Error && "code" in error && (error as { code: unknown }).code === code) as Promise<void>;
}

test("P4-001: schema 1.3 template validates", async () => {
  const report = await validateBundleDirectory(path.resolve("templates/task-bundle"));
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.manifest?.schema_version, "1.3");
});

test("P4-002: schema 1.2 cannot execute Phase 4", () => {
  const report = validatePhase4ExecutionContract({ schema_version: "1.2" });
  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.code, "EXECUTION_SCHEMA_UPGRADE_REQUIRED");
});

test("P4-003/P4-004/P4-005: structured command rejects strings and unsafe executables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-"));
  try {
    await expectCode(() => validateStructuredValidationContract({ commands: [{ id: "x", command: "npm test", executable: "npm", args: [], cwd: ".", environment: {}, required: true, timeout_seconds: 1, maximum_output_bytes: 100 }] }, root, { allowed_executables: ["npm"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 1000 }), "VALIDATION_CONTRACT_INVALID");
    await expectCode(() => { validateExecutable("/bin/npm", ["npm"]); }, "VALIDATION_EXECUTABLE_DENIED");
    await expectCode(() => { validateExecutable("node/x", ["node/x"]); }, "VALIDATION_EXECUTABLE_DENIED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-006/P4-007/P4-008: cwd and environment policies fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-"));
  try {
    await expectCode(() => validateStructuredValidationContract({ commands: [{ id: "x", executable: "node", args: [], cwd: "../outside", environment: {}, required: true, timeout_seconds: 1, maximum_output_bytes: 100 }] }, root, { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 1000 }), "VALIDATION_CWD_UNSAFE");
    assert.throws(() => validateEnvironment({ PATH: "fake" }, ["PATH"]), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_ENVIRONMENT_DENIED");
    assert.throws(() => validateEnvironment({ FAKE_TOKEN: "must-not-persist" }, ["FAKE_TOKEN"]), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_ENVIRONMENT_DENIED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-009/P4-010: bundle cannot choose agent or network policy", () => {
  const base = { schema_version: "1.3", task_id: "task", title: "x", repository: { id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, delivery: { mode: "github_pull_request", remote: "origin", base_branch: "main", branch_name: "codex/task", draft: true, push_after: ["VERIFIER_PASS", "SOL_APPROVE"], auto_merge: false }, git_policy: { allowed_remote: "origin", allowed_branch_prefix: "codex/", deny_direct_push_branches: ["main"], allow_force_push: false, allow_remote_branch_delete: false, allow_merge: false }, limits: { max_internal_iterations: 1, max_review_rounds: 1, max_changed_files: 1, max_diff_lines: 10 }, allowed_paths: ["src/**"], forbidden_paths: [".git/**"], agents: { model: "evil" }, network: true };
  const report = validatePhase4ExecutionContract(base);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "DELIVERY_CONTRACT_INVALID"));
});

test("P4-011/P4-012: trusted config rejects unknown fields and is not weakened by bundle", () => {
  const report = validateConfig({ config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 }, repositories: { repo: { path: "/tmp/repo", remote: "origin", expected_remote_urls: ["file:///tmp/repo"], fetch_policy: "never" } }, unknown: true });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.message.includes("Unknown top-level")));
});

test("P4-013 and P4-084: state transitions are explicit", () => {
  assert.equal(canTransition("READY_FOR_CODEX", "CODEX_PREFLIGHT"), true);
  assert.equal(canTransition("SOL_REVIEWING", "TERRA_REVIEWING"), false);
  assert.throws(() => assertTransition("SOL_REVIEWING", "TERRA_REVIEWING"), (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_STATE_INVALID");
});

test("P4-018/P4-019: runtime and sandbox fail closed", async () => {
  await expectCode(() => resolveCodexRuntime(undefined), "CODEX_RUNTIME_NOT_FOUND");
  await expectCode(() => new CodexVerificationSandbox(fakeResolvedCodexRuntime()).run("node", [], { cwd: ".", env: {}, timeoutMs: 10, maximumOutputBytes: 10, network_access: true, writable_root: ".", credential_directories: [] }), "VERIFIER_SANDBOX_UNAVAILABLE");
  assert.ok(new FakeAgentClient().calls.length === 0);
  assert.ok(new FakeVerificationSandbox().calls.length === 0);
});

test("P4-020/P4-024/P4-029/P4-036: agent output schemas are strict", () => {
  assert.equal(validateAssessment({ status: "COMPATIBLE", summary: "ok", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null }).status, "COMPATIBLE");
  assert.equal(validateImplementation({ status: "READY_FOR_VERIFICATION", summary: "ok", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null }).status, "READY_FOR_VERIFICATION");

  assert.equal(
    validateReview({
      verdict: "APPROVE",
      reviewed_change_set_sha256: "a".repeat(64),
      summary: "ok",
      acceptance_results: [],
      blocking_findings: [],
      non_blocking_findings: [],
      scope_violations: [],
      unverified_acceptance: [],
      human_action: null,
    }).verdict,
    "APPROVE",
  );
  assert.throws(() => validateAssessment({ status: "COMPATIBLE", summary: "ok", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null, hidden_reasoning: "no" }), (error: unknown) => error instanceof ExecutionError && error.code === "AGENT_OUTPUT_INVALID");
  assert.throws(() => validateImplementation({ status: "READY_FOR_VERIFICATION", summary: "ok", changed_files_claimed: ["../escape"], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null, extra: true }), (error: unknown) => error instanceof ExecutionError && error.code === "AGENT_OUTPUT_INVALID");
});

test("P4-025/P4-026/P4-027/P4-033/P4-034: path policy enforces scope and limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-"));
  try {
    await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "ok.ts"), "ok\n");
    const change = { change_set_sha256: "a".repeat(64), base_commit: "b".repeat(40), branch_name: "codex/task", entries: [{ path: "src/ok.ts", change_type: "added" as const, mode: "000644", content_sha256: "c".repeat(64), binary: false }], diff_lines: 1, tracked_paths: [], untracked_paths: ["src/ok.ts"], generated_paths: [] };
    await enforcePathPolicy({ worktreePath: root, allowedPaths: ["src/**"], forbiddenPaths: [".git/**"], maximumChangedFiles: 1, maximumDiffLines: 2 }, change);
    await expectCode(() => enforcePathPolicy({ worktreePath: root, allowedPaths: ["tests/**"], forbiddenPaths: [], maximumChangedFiles: 1, maximumDiffLines: 2 }, change), "PATH_POLICY_VIOLATION");
    await expectCode(() => enforcePathPolicy({ worktreePath: root, allowedPaths: ["src/**"], forbiddenPaths: [], maximumChangedFiles: 0, maximumDiffLines: 2 }, change), "CHANGE_LIMIT_EXCEEDED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-037/P4-038: change-set digest changes when content changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-"));
  try {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<void>((resolve, reject) => execFile("git", args, { cwd: root }, (error) => error ? reject(error) : resolve()));
    await run(["init", "-b", "main"]); await run(["config", "user.email", "p4@example.invalid"]); await run(["config", "user.name", "P4"]); await writeFile(path.join(root, "README.md"), "one\n"); await run(["add", "."]); await run(["commit", "-m", "base"]); const { execFile: ef } = await import("node:child_process"); const base = await new Promise<string>((resolve, reject) => ef("git", ["rev-parse", "HEAD"], { cwd: root }, (e, _o, err) => e ? reject(err) : resolve(_o.trim()))); await writeFile(path.join(root, "README.md"), "two\n"); const first = await calculateChangeSet({ worktreePath: root, baseCommit: base, branchName: "main" }); await writeFile(path.join(root, "README.md"), "three\n"); const second = await calculateChangeSet({ worktreePath: root, baseCommit: base, branchName: "main" }); assert.notEqual(first.change_set_sha256, second.change_set_sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-039/P4-040/P4-041/P4-043/P4-044/P4-045/P4-050: fake sandbox is sequential and bounded", async () => {
  const sandbox = new FakeVerificationSandbox([{ exitCode: 0, stdout: "pass" }, { exitCode: 1, stderr: "optional fail" }]);
  const first = await sandbox.run("node", ["--version"], { cwd: ".", env: {}, timeoutMs: 100, maximumOutputBytes: 100 });
  const second = await sandbox.run("node", ["--bad"], { cwd: ".", env: {}, timeoutMs: 100, maximumOutputBytes: 100 });
  assert.equal(first.exitCode, 0); assert.equal(second.exitCode, 1); assert.deepEqual(sandbox.calls.map((call) => call.executable), ["node", "node"]);
  assert.throws(() => validateArguments("git", ["push", "origin", "main"]), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_EXECUTABLE_DENIED");
  assert.throws(() => validateArguments("npm", ["install"]), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_EXECUTABLE_DENIED");
});

function receipt(digest: string): ExecutionReceipt {
  return { execution_version: "1.0", run_id: "task:" + "a".repeat(64), state: "SOL_REVIEWING", base_commit: "b".repeat(40), branch_name: "codex/task", worktree_path: "/tmp/worktree", accepted_bundle_path: "/tmp/bundle", implementer: { model: "terra", reasoning_effort: "high", thread_id: "impl", iterations: 1 }, internal_reviewer: { model: "terra", reasoning_effort: "high", rounds: 1, latest_thread_id: "terra-review", verdict: "APPROVE", reviewed_change_set_sha256: digest }, final_reviewer: { model: "sol", reasoning_effort: "high", rounds: 1, latest_thread_id: "sol-review", verdict: "APPROVE", reviewed_change_set_sha256: digest }, verification: { rounds: 1, required_commands_passed: true, verified_change_set_sha256: digest, commands: [] }, change_set_sha256: digest, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, errors: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

function review(digest: string): ReviewResult { return { verdict: "APPROVE", reviewed_change_set_sha256: digest, summary: "ok", acceptance_results: [], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], human_action: null }; }

test("P4-053/P4-056/P4-069/P4-072/P4-085/P4-087: review gates require one digest and order", () => {
  const digest = "d".repeat(64); const current = receipt(digest); const terra = review(digest); const sol = review(digest);
  assert.doesNotThrow(() => assertSolCanStart(current, terra)); assert.doesNotThrow(() => assertReadyForPublish(current, terra, sol));
  assert.throws(() => assertSolCanStart(receipt("e".repeat(64)), terra), (error: unknown) => error instanceof ExecutionError && error.code === "SOL_REVIEW_NOT_ALLOWED");
  assert.throws(() => assertReadyForPublish(current, review("e".repeat(64)), sol), (error: unknown) => error instanceof ExecutionError && error.code === "TERRA_REVIEW_REQUIRED");
});

test("P4-057/P4-058/P4-070/P4-073/P4-074: blocking findings, unverified ACs, and thread reuse cannot pass gates", () => {
  const digest = "d".repeat(64); const current = receipt(digest); const invalid: ReviewResult = { ...review(digest), blocking_findings: [{ id: "F-1", severity: "high", category: "correctness", file: "src/file.ts", line_start: 1, line_end: 1, acceptance_ids: [], problem: "bad", evidence: "bad", required_fix: "fix" }] };
  current.verification.required_commands_passed = true;
  assert.throws(() => assertTerraCanStart(current, invalid), (error: unknown) => error instanceof ExecutionError && error.code === "TERRA_REVIEW_REQUIRED");
  assert.throws(() => assertSolCanStart(current, invalid), (error: unknown) => error instanceof ExecutionError && error.code === "SOL_REVIEW_NOT_ALLOWED");
  current.internal_reviewer.latest_thread_id = current.implementer.thread_id;
  assert.throws(() => assertSolCanStart(current, review(digest)), (error: unknown) => error instanceof ExecutionError && error.code === "SOL_REVIEW_NOT_ALLOWED");
});

test("P4-020/P4-025/P4-039/P4-056/P4-072/P4-086: fake execution reaches READY_FOR_PUBLISH", async () => {
  const rootRaw = await mkdtemp(path.join(os.tmpdir(), "wco-p4-exec-"));
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(rootRaw);
  try {
    const state = path.join(root, "state"); const bundle = path.join(state, "accepted", "task", "a".repeat(64)); const worktree = path.join(state, "worktrees", "task", "a".repeat(64), "repository");
    await mkdir(bundle, { recursive: true }); await mkdir(worktree, { recursive: true });
    const { execFile } = await import("node:child_process");
    const run = (args: string[], cwd: string) => new Promise<string>((resolve, reject) => execFile("git", args, { cwd }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout.trim())));
    await run(["init", "-b", "main"], worktree); await run(["config", "user.email", "p4@example.invalid"], worktree); await run(["config", "user.name", "P4"], worktree); await writeFile(path.join(worktree, "README.md"), "fixture\n"); await run(["add", "README.md"], worktree); await run(["commit", "-m", "fixture"], worktree); const base = await run(["rev-parse", "HEAD"], worktree); await run(["checkout", "-b", "codex/207-scala-rule-pack"], worktree);
    await cp(path.resolve("templates/task-bundle"), bundle, { recursive: true }); const manifestPath = path.join(bundle, "manifest.json"); const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8")) as Record<string, unknown>; (manifest.repository as Record<string, unknown>).id = "repo"; (manifest.repository as Record<string, unknown>).base_commit = base; await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); await updateChecksums(bundle);
    const configPath = path.join(root, "config.json"); await writeFile(configPath, JSON.stringify({ config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 }, repositories: { repo: { path: worktree, remote: "origin", expected_remote_urls: ["file:///tmp/unused"], fetch_policy: "never" } }, runtime: { source: "bundled" }, agents: { implementer: { model: "terra", reasoning_effort: "high" }, internal_reviewer: { model: "terra", reasoning_effort: "high" }, final_reviewer: { model: "sol", reasoning_effort: "high" }, limits: { maximum_implementation_iterations: 2, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 8, maximum_turn_seconds: 60, maximum_total_seconds: 120, maximum_total_input_tokens: 10000, maximum_total_output_tokens: 10000 } }, verification: { allowed_executables: ["npm"], allowed_environment_keys: ["CI"], maximum_command_seconds: 600, maximum_output_bytes: 4194304, allowed_generated_paths: ["dist/**"] } }, null, 2));
    const runDirectory = path.join(state, "runs", "task", "a".repeat(64)); await mkdir(runDirectory, { recursive: true }); const runId = `task:${"a".repeat(64)}`; await writeFile(path.join(runDirectory, "run.json"), JSON.stringify({ run_version: "1.0", run_id: runId, status: "READY_FOR_CODEX", task_id: "task", archive_sha256: "a".repeat(64), bundle_schema_version: "1.3", repository_id: "repo", repository_path: worktree, remote: "origin", remote_url: "file:///tmp/unused", base_branch: "main", base_commit: base, branch_name: "codex/207-scala-rule-pack", worktree_path: worktree, accepted_bundle_path: bundle, state: "READY_FOR_CODEX", checks: [], errors: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
    const client = new FakeAgentClient([(request: AgentTurnRequest) => request.role === "implementer" && request.read_only ? { status: "COMPATIBLE", summary: "ok", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null } : request.role === "implementer" ? { status: "READY_FOR_VERIFICATION", summary: "done", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null } : (() => { const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64); return { verdict: "APPROVE", reviewed_change_set_sha256: digest, summary: "ok", acceptance_results: [{ acceptance_id: "AC-001", status: "PASS", evidence: ["fake"] }, { acceptance_id: "AC-002", status: "PASS", evidence: ["fake"] }], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], human_action: null }; })()]);
    const result = await executeRun({ runId, stateDirectory: state, configPath, agentClient: client, sandbox: new FakeVerificationSandbox() });
    assert.equal(result.state, "READY_FOR_PUBLISH"); assert.equal(client.calls.filter((call) => call.read_only).length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
