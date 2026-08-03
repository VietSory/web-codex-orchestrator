import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { BudgetTracker } from "../src/execution/budget.js";
import { effectiveLimit } from "../src/execution/execution-config.js";
import { validateConfig } from "../src/config/config-validator.js";
import { ExecutionError } from "../src/execution/errors.js";
import { calculateChangeSet } from "../src/execution/change-set.js";
import { enforcePathPolicy } from "../src/execution/path-policy.js";
import { assertTransition, canTransition } from "../src/execution/state-machine.js";
import { writeExecutionText } from "../src/execution/execution-store.js";
import { readExecutionReceipt } from "../src/execution/execution-store.js";
import { acquireExecutionLock } from "../src/execution/execution-lock.js";
import { snapshotBundle, assertBundleUnchanged } from "../src/execution/bundle-integrity.js";
import { executeRun } from "../src/execution/execution-service.js";
import { validateEnvironment } from "../src/verifier/environment-policy.js";
import { validateArguments } from "../src/verifier/executable-policy.js";
import { ChildProcessSandbox } from "./helpers/child-process-sandbox.js";
import { verifyDeterministically } from "../src/verifier/verifier.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "../src/verifier/contracts.js";
import { createPhase4Fixture, type Phase4Fixture } from "./helpers/phase4-fixture.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { fakeResolvedCodexRuntime } from "./helpers/codex-runtime-fixture.js";

const execFileAsync = promisify(execFile);

function expectCode(action: () => unknown | Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(async () => await action(), (error: unknown) => error instanceof Error && "code" in error && (error as { code: unknown }).code === code) as Promise<void>;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(result.stdout).trim();
}

async function gitFixture(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-hardening-git-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "p4-hardening@example.invalid"]);
  await git(root, ["config", "user.name", "P4 Hardening"]);
  await writeFile(path.join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  return { root, base: await git(root, ["rev-parse", "HEAD"]) };
}

test("P4-H-001: reserved environment keys and npm network commands are denied", () => {
  for (const key of ["SHELL", "COMSPEC", "CODEX_HOME", "GIT_DIR", "GIT_WORK_TREE"]) {
    assert.throws(() => validateEnvironment({ [key]: "x" }, [key]), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_ENVIRONMENT_DENIED");
  }
  for (const args of [["exec", "curl"], ["view", "package"], ["audit"], ["pack"]]) {
    assert.throws(() => validateArguments("npm", args), (error: unknown) => error instanceof ExecutionError && error.code === "VALIDATION_EXECUTABLE_DENIED");
  }
});

test("P4-H-002: unrestricted child-process sandbox fails closed", async () => {
  await expectCode(() => new ChildProcessSandbox().run("node", ["--version"], { cwd: ".", env: {}, timeoutMs: 100, maximumOutputBytes: 100, network_access: false, writable_root: ".", credential_directories: [] }), "VERIFIER_SANDBOX_UNAVAILABLE");
});

test("P4-H-003: Git ref mutations change the canonical change set", async () => {
  const fixture = await gitFixture();
  try {
    const before = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    await git(fixture.root, ["update-ref", "refs/heads/side", fixture.base]);
    const after = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    assert.notEqual(before.refs_sha256, after.refs_sha256);
    assert.notEqual(before.change_set_sha256, after.change_set_sha256);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-H-003: mutable Git hooks and configuration change the canonical boundary", async () => {
  const fixture = await gitFixture();
  try {
    const before = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    await writeFile(path.join(fixture.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    const afterHook = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    assert.notEqual(before.refs_sha256, afterHook.refs_sha256);
    await git(fixture.root, ["config", "wco.hardening", "changed"]);
    const afterConfig = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    assert.notEqual(afterHook.refs_sha256, afterConfig.refs_sha256);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-031/P4-032/P4-H-003: staged Git metadata is part of the change-set boundary", async () => {
  const fixture = await gitFixture();
  try {
    const before = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    await writeFile(path.join(fixture.root, "README.md"), "staged-only\n");
    await git(fixture.root, ["add", "README.md"]);
    const after = await calculateChangeSet({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main" });
    assert.notEqual(before.refs_sha256, after.refs_sha256);
    assert.notEqual(before.change_set_sha256, after.change_set_sha256);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-H-004: path policy rejects symlinks, special entries, and oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-hardening-path-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "large.ts"), "123456789\n");
    await symlink("large.ts", path.join(root, "src", "link.ts"));
    const base = { change_set_sha256: "a".repeat(64), base_commit: "b".repeat(40), branch_name: "codex/task", diff_lines: 1, tracked_paths: [], untracked_paths: [], generated_paths: [], entries: [] as never[] };
    await expectCode(() => enforcePathPolicy({ worktreePath: root, allowedPaths: ["src/**"], forbiddenPaths: [], maximumChangedFiles: 3, maximumDiffLines: 10, maximumFileBytes: 4 }, { ...base, entries: [{ path: "src/large.ts", change_type: "added", mode: "100644", content_sha256: "c".repeat(64), binary: false, special: false }] }), "CHANGE_LIMIT_EXCEEDED");
    await expectCode(() => enforcePathPolicy({ worktreePath: root, allowedPaths: ["src/**"], forbiddenPaths: [], maximumChangedFiles: 3, maximumDiffLines: 10 }, { ...base, entries: [{ path: "src/link.ts", change_type: "added", mode: "120000", content_sha256: "c".repeat(64), binary: false, special: false }] }), "SYMLINK_CHANGE_NOT_ALLOWED");
    await expectCode(() => enforcePathPolicy({ worktreePath: root, allowedPaths: ["src/**"], forbiddenPaths: [], maximumChangedFiles: 3, maximumDiffLines: 10 }, { ...base, entries: [{ path: "src/device", change_type: "added", mode: "000000", content_sha256: null, binary: false, special: true }] }), "SPECIAL_FILE_CHANGE_NOT_ALLOWED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

class MutatingSandbox implements VerificationSandbox {
  constructor(private readonly relativePath: string) {}
  async run(_executable: string, _args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    await mkdir(path.dirname(path.join(options.writable_root!, this.relativePath)), { recursive: true });
    await writeFile(path.join(options.writable_root!, this.relativePath), "generated\n");
    return { exitCode: 0, signal: null, stdout: "ok", stderr: "", stdout_bytes: 2, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 1 };
  }
}

test("P4-H-005: verifier records generated artifacts and blocks source mutation", async () => {
  const fixture = await gitFixture();
  try {
    const validation = { commands: [{ id: "test", executable: "node", args: ["--version"], cwd: ".", environment: {}, required: true, timeout_seconds: 1, maximum_output_bytes: 100 }] };
    const policy = { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 1000, allowed_generated_paths: ["dist/**"] };
    const generated = await verifyDeterministically({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main", validation, policy, sandbox: new MutatingSandbox("dist/output.txt") });
    assert.deepEqual(generated.commands[0]?.generated_paths, ["dist/output.txt"]);

    await expectCode(() => verifyDeterministically({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main", validation, policy, sandbox: new MutatingSandbox("README.md") }), "VERIFIER_MUTATED_SOURCE");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-H-006: persisted budget counts assessment turns and cached input", () => {
  const tracker = new BudgetTracker({ maximum_implementation_iterations: 2, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 3, maximum_turn_seconds: 10, maximum_total_seconds: 60, maximum_total_input_tokens: 10, maximum_total_output_tokens: 10 }, Date.now() - 1_000, { totalTurns: 1, cachedInputTokens: 1 });
  tracker.beginAssessment();
  tracker.recordTokens(2, 1, 3);
  assert.equal(tracker.usage.totalTurns, 2);
  assert.equal(tracker.usage.cachedInputTokens, 4);
  assert.throws(() => tracker.recordTokens(6, 0), (error: unknown) => error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED");
});

test("P4-H-007: interruption can resume through a fixing state", () => {
  assert.equal(canTransition("INTERRUPTED", "TERRA_FIXING"), true);
  assert.doesNotThrow(() => assertTransition("INTERRUPTED", "TERRA_FIXING"));
});

test("P4-H-008: fake agent preserves a thread across turns", async () => {
  const client = new FakeAgentClient();
  const first = await client.turn({ role: "implementer", model: "terra", reasoning_effort: "high", prompt: "x", output_schema: {}, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: process.cwd(), accepted_bundle_path: path.resolve("templates/task-bundle") });
  const response = await client.turn({ role: "implementer", model: "terra", reasoning_effort: "high", thread_id: first.thread_id, prompt: "x", output_schema: {}, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: process.cwd(), accepted_bundle_path: path.resolve("templates/task-bundle") });
  assert.equal(response.thread_id, first.thread_id);
});

test("P4-018/P4-019: runtime auth preflight fails closed without exposing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-codex-preflight-"));
  try {
    const launcher = path.join(root, "fake-bundled-codex.js");
    await writeFile(launcher, "if (process.argv.includes('--version')) process.stdout.write('codex-cli 0.145.0\\n'); else process.exit(1);\n");
    const runtime = fakeResolvedCodexRuntime({ prefix_args: [launcher], launcher_path: launcher, environment: {} });
    await expectCode(() => new CodexSdkAgentClient(runtime).checkAvailability(), "CODEX_AUTH_UNAVAILABLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-H-009: verification outputs remain bounded and redacted in command results", async () => {
  const fixture = await gitFixture();
  try {
    const validation = { commands: [{ id: "test", executable: "node", args: ["--version"], cwd: ".", environment: {}, required: true, timeout_seconds: 1, maximum_output_bytes: 10 }] };
    const result = await verifyDeterministically({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main", validation, policy: { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 10, allowed_generated_paths: [] }, sandbox: { async run() { return { exitCode: 0, signal: null, stdout: "token: secret", stderr: "", stdout_bytes: 12, stderr_bytes: 0, stdout_truncated: true, stderr_truncated: false, timed_out: false, duration_ms: 1 }; } } });
    assert.equal(result.commands[0]?.stdout, "token: [REDACTED]");
    assert.equal(result.commands[0]?.stdout_truncated, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-012: bundle limits cannot raise trusted change limits", () => {
  assert.equal(effectiveLimit(50, 8000), 50);
  assert.equal(effectiveLimit(8000, 50), 50);
});

test("P4-007/P4-045/P4-046: trusted verifier config rejects shell, network, and reserved environment capabilities", () => {
  const base = { config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 }, repositories: { repo: { path: "/tmp/repo", remote: "origin", expected_remote_urls: ["file:///tmp/repo"], fetch_policy: "never" } }, verification: { allowed_executables: ["sh"], allowed_environment_keys: ["PATH"], maximum_command_seconds: 1, maximum_output_bytes: 1, allowed_generated_paths: [] } };
  const report = validateConfig(base);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.message.includes("executable")));
  assert.ok(report.issues.some((issue) => issue.message.includes("environment")));
});

test("P4-042: verifier records a bounded timeout as VERIFIER_TIMEOUT", async () => {
  const fixture = await gitFixture();
  try {
    const validation = { commands: [{ id: "slow", executable: "node", args: ["--version"], cwd: ".", environment: {}, required: true, timeout_seconds: 1, maximum_output_bytes: 10 }] };
    await expectCode(() => verifyDeterministically({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main", validation, policy: { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 10, allowed_generated_paths: [] }, sandbox: { async run() { return { exitCode: null, signal: "SIGTERM", stdout: "tail", stderr: "timed", stdout_bytes: 4, stderr_bytes: 5, stdout_truncated: false, stderr_truncated: false, timed_out: true, duration_ms: 10 }; } } }), "VERIFIER_TIMEOUT");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-041/P4-042: optional verifier timeout is recorded without failing required gates", async () => {
  const fixture = await gitFixture();
  try {
    const validation = { commands: [{ id: "optional-slow", executable: "node", args: ["--version"], cwd: ".", environment: {}, required: false, timeout_seconds: 1, maximum_output_bytes: 10 }] };
    const result = await verifyDeterministically({ worktreePath: fixture.root, baseCommit: fixture.base, branchName: "main", validation, policy: { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 10, maximum_output_bytes: 10, allowed_generated_paths: [] }, sandbox: { async run() { return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, timed_out: true, duration_ms: 10 }; } } });
    assert.equal(result.required_commands_passed, true);
    assert.equal(result.commands[0]?.status, "TIMEOUT");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("P4-H-010: generated artifact writes are atomic and readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-hardening-atomic-"));
  try {
    const digest = "a".repeat(64);
    await writeExecutionText(root, "task", digest, "verification", "token: secret\n", "round-001/stdout.log");
    const output = await readFile(path.join(root, "runs", "task", digest, "execution", "verification", "round-001", "stdout.log"), "utf8");
    assert.equal(output, "token: [REDACTED]\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function assessment(status: "COMPATIBLE" | "REPLAN_REQUIRED" | "HUMAN_REQUIRED" | "BLOCKED" = "COMPATIBLE"): unknown {
  return { status, summary: status, repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null };
}

function implementation(): unknown {
  return { status: "READY_FOR_VERIFICATION", summary: "implemented", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null };
}

function reviewFor(request: { prompt: string }, verdict: "APPROVE" | "REVISE" | "REPLAN" | "ESCALATE" = "APPROVE"): unknown {
  const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64);
  const result: Record<string, unknown> = { verdict, reviewed_change_set_sha256: digest, summary: verdict, acceptance_results: [{ acceptance_id: "AC-001", status: "PASS", evidence: ["fixture"] }, { acceptance_id: "AC-002", status: "PASS", evidence: ["fixture"] }], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], recommended_next_state: "SOL_REVIEWING", human_action: null };
  if (verdict === "REVISE") result.blocking_findings = [{ id: "FIX-001", severity: "high", category: "correctness", file: "README.md", line_start: 1, line_end: 1, acceptance_ids: ["AC-001"], problem: "fixture finding", evidence: "fixture", required_fix: "fix" }];
  return result;
}

async function runFixture(fixture: Phase4Fixture, responses: Array<unknown | ((request: AgentTurnRequest) => unknown | Promise<unknown>)>, sandbox = new FakeVerificationSandbox()) {
  return executeRun({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.configPath, agentClient: new FakeAgentClient(responses), sandbox });
}

test("P4-021/P4-022: assessment replans and human escalation stop before implementation", async () => {
  for (const status of ["REPLAN_REQUIRED", "HUMAN_REQUIRED"] as const) {
    const fixture = await createPhase4Fixture();
    try {
      const result = await runFixture(fixture, [assessment(status)]);
      assert.equal(result.state, status);
      assert.equal(result.implementer.iterations, 0);
    } finally { await fixture.cleanup(); }
  }
});

test("P4-023/P4-024: assessment mutation is blocked and malformed output gets one repair turn", async () => {
  const mutated = await createPhase4Fixture();
  try {
    const client = new FakeAgentClient([(request: AgentTurnRequest) => { if (request.read_only) return writeFile(path.join(mutated.worktree, "README.md"), "mutated\n").then(() => assessment()); return implementation(); }]);
    await expectCode(() => executeRun({ runId: mutated.runId, stateDirectory: mutated.state, configPath: mutated.configPath, agentClient: client, sandbox: new FakeVerificationSandbox() }), "AGENT_ASSESSMENT_MUTATED_WORKTREE");
    const receipt = await readExecutionReceipt(mutated.state, "task", "a".repeat(64));
    assert.equal(receipt?.state, "AGENT_FAILED");
  } finally { await mutated.cleanup(); }

  const repaired = await createPhase4Fixture();
  try {
    let assessmentTurns = 0;
    const result = await runFixture(repaired, [() => { assessmentTurns += 1; return "not-json"; }, () => { assessmentTurns += 1; return assessment(); }, implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => reviewFor(request)]);
    assert.equal(result.state, "READY_FOR_PUBLISH");
    assert.equal(assessmentTurns, 2);
  } finally { await repaired.cleanup(); }
});

test("P4-040/P4-081: required verifier failure causes a Terra fix and a second verification round", async () => {
  const fixture = await createPhase4Fixture();
  try {
    const sandbox = new FakeVerificationSandbox([{ exitCode: 1, stderr: "failed" }, { exitCode: 0, stdout: "pass" }]);
    const result = await runFixture(fixture, [assessment(), implementation(), implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => reviewFor(request)], sandbox);
    assert.equal(result.state, "READY_FOR_PUBLISH");
    assert.equal(result.verification.rounds, 2);
    assert.equal(sandbox.calls.length, 6);
  } finally { await fixture.cleanup(); }
});

test("P4-059/P4-065/P4-067/P4-082: Terra REVISE invalidates approval and starts a fresh review round", async () => {
  const fixture = await createPhase4Fixture();
  try {
    let terraReviews = 0;
    const result = await runFixture(fixture, [assessment(), implementation(), (request: AgentTurnRequest) => { terraReviews += 1; return reviewFor(request, "REVISE"); }, implementation(), (request: AgentTurnRequest) => { terraReviews += 1; return reviewFor(request); }, (request: AgentTurnRequest) => reviewFor(request)]);
    assert.equal(result.state, "READY_FOR_PUBLISH");
    assert.equal(result.internal_reviewer.rounds, 2);
    assert.equal(terraReviews, 2);
    assert.equal(result.final_reviewer.rounds, 1);
    assert.ok((result.internal_reviewer.thread_ids ?? []).length >= 2);
  } finally { await fixture.cleanup(); }
});

test("P4-075/P4-083/P4-084: Sol REVISE reruns Terra and Sol in order with independent threads", async () => {
  const fixture = await createPhase4Fixture();
  try {
    let solReviews = 0;
    const result = await runFixture(fixture, [assessment(), implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => { solReviews += 1; return reviewFor(request, "REVISE"); }, implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => { solReviews += 1; return reviewFor(request); }]);
    assert.equal(result.state, "READY_FOR_PUBLISH");
    assert.equal(result.internal_reviewer.rounds, 2);
    assert.equal(result.final_reviewer.rounds, 2);
    assert.equal(solReviews, 2);
    assert.ok((result.final_reviewer.thread_ids ?? []).every((thread) => !(result.internal_reviewer.thread_ids ?? []).includes(thread)));
  } finally { await fixture.cleanup(); }
});

test("P4-095/P4-100: completed execution is idempotent and status reads do not start agents", async () => {
  const fixture = await createPhase4Fixture();
  try {
    const first = await runFixture(fixture, [assessment(), implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => reviewFor(request)]);
    assert.equal(first.state, "READY_FOR_PUBLISH");
    const client = new FakeAgentClient();
    const sandbox = new FakeVerificationSandbox();
    const second = await executeRun({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.configPath, agentClient: client, sandbox });
    assert.equal(second.state, "READY_FOR_PUBLISH");
    assert.equal(client.calls.length, 0);
    assert.equal(sandbox.calls.length, 0);
  } finally { await fixture.cleanup(); }
});

test("P4-098: only one executor lock can own a run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-p4-lock-"));
  try {
    const digest = "b".repeat(64);
    const first = await acquireExecutionLock(root, digest);
    await expectCode(() => acquireExecutionLock(root, digest), "EXECUTION_LOCKED");
    await first.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4-094/P4-096/P4-105/P4-106: interrupted agent work persists and resumes the same run", async () => {
  const fixture = await createPhase4Fixture();
  try {
    const controller = new AbortController();
    let interrupted = false;
    const firstClient = new FakeAgentClient([assessment(), (request: AgentTurnRequest) => {
      if (!interrupted) {
        interrupted = true;
        queueMicrotask(() => controller.abort());
        return new Promise((_, reject) => {
          if (request.signal?.aborted) reject(new ExecutionError("INTERRUPTED", "cancelled"));
          else request.signal?.addEventListener("abort", () => reject(new ExecutionError("INTERRUPTED", "cancelled")), { once: true });
        });
      }
      return implementation();
    }]);
    await expectCode(() => executeRun({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.configPath, agentClient: firstClient, sandbox: new FakeVerificationSandbox(), signal: controller.signal }), "INTERRUPTED");
    const interruptedReceipt = await readExecutionReceipt(fixture.state, "task", "a".repeat(64));
    assert.equal(interruptedReceipt?.state, "INTERRUPTED");

    const resumed = await runFixture(fixture, [assessment(), implementation(), (request: AgentTurnRequest) => reviewFor(request), (request: AgentTurnRequest) => reviewFor(request)]);
    assert.equal(resumed.state, "READY_FOR_PUBLISH");
    assert.ok(resumed.implementer.iterations >= 2);
  } finally { await fixture.cleanup(); }
});
