import test from "node:test";
import assert from "node:assert";
import { projectExecutionEvidence, projectGitPublishEvidence, projectDraftPrEvidence, projectVerificationEvidence, redactVerificationOutput } from "../src/result-bundle/public-evidence.js";

test("Phase 6 Public Evidence: project execution evidence", () => {
  const internal = {
    run_id: "TASK-1:abcd",
    state: "READY_FOR_PUBLISH",
    change_set_sha256: "change123",
    base_commit: "base456",
    branch_name: "codex/task",
    implementer: { model: "gpt-4", reasoning_effort: "high", iterations: 2 },
    internal_reviewer: { model: "gpt-4o", reasoning_effort: "low", rounds: 1, verdict: "APPROVE", reviewed_change_set_sha256: "change123" },
    final_reviewer: { rounds: 0 },
    verification: { rounds: 2, required_commands_passed: true },
    usage: { input_tokens: 100, output_tokens: 50 },
    worktree_path: "/tmp/secret/worktree", // Should be omitted
    accepted_bundle_path: "/tmp/secret/bundle.zip" // Should be omitted
  };
  
  const pub = projectExecutionEvidence(internal);
  assert.equal(pub.run_id, "TASK-1:abcd");
  assert.equal(pub.task_id, "TASK-1");
  assert.equal(pub.implementer.iterations, 2);
  assert.equal(pub.internal_reviewer.verdict, "APPROVE");
  assert.equal((pub as any).worktree_path, undefined);
  assert.equal((pub as any).accepted_bundle_path, undefined);
});

test("Phase 6 Public Evidence: project git publish evidence", () => {
  const internal = {
    run_id: "TASK-1:abcd",
    state: "PUSHED",
    base_commit: "base",
    branch_name: "branch",
    remote_name: "origin",
    change_set_sha256: "change",
    expected_paths: ["a.txt"],
    commit_sha: "commit",
    remote_branch_sha: "commit",
    created_at: "time1",
    pushed_at: "time2",
    private_auth_data: "secret" // Omitted
  };
  const pub = projectGitPublishEvidence(internal);
  assert.deepEqual(pub.expected_paths, ["a.txt"]);
  assert.equal(pub.commit_sha, "commit");
  assert.equal((pub as any).private_auth_data, undefined);
});

test("Phase 6 Public Evidence: redact verification output", () => {
  const small = "Hello world";
  const r1 = redactVerificationOutput(small, 100);
  assert.equal(r1.text, "Hello world");
  assert.equal(r1.truncated, false);

  const large = "A".repeat(200);
  const r2 = redactVerificationOutput(large, 100);
  assert.equal(r2.text.length, 100 + "\n[output truncated]".length);
  assert.equal(r2.truncated, true);
  assert.ok(r2.text.endsWith("\n[output truncated]"));
});

test("Phase 6 Public Evidence: preserves bounded Harness command identity and outcome", () => {
  const projected = projectVerificationEvidence({
    rounds: 1,
    required_commands_passed: true,
    verified_change_set_sha256: "a".repeat(64),
    commands: [{
      command_id: "VERIFY-1", required: true, status: "PASS", exit_code: 0, timed_out: false,
      duration_ms: 42, stdout_truncated: false, stderr_truncated: false,
      stdout_tail: "2 tests passed", stderr_tail: "",
    }],
  }, 1024) as any;
  assert.equal(projected.commands.length, 1);
  assert.deepEqual(projected.commands[0], {
    command_id: "VERIFY-1", required: true, exit_code: 0, status: "PASS", timed_out: false,
    duration_ms: 42, stdout_bytes: 14, stderr_bytes: 0, stdout_truncated: false,
    stderr_truncated: false, stdout: "2 tests passed", stderr: "", generated_paths: [],
  });
});
