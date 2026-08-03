import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { executeRun } from "../src/execution/execution-service.js";
import { executionPaths } from "../src/execution/execution-store.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "../src/verifier/contracts.js";
import { createPhase4Fixture } from "./helpers/phase4-fixture.js";

function assessment(): unknown {
  return { status: "COMPATIBLE", summary: "fixture", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null };
}

function implementation(): unknown {
  return { status: "READY_FOR_VERIFICATION", summary: "fixture", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null };
}

function review(request: AgentTurnRequest): unknown {
  const digest = /Change-set digest: ([0-9a-f]{64})/.exec(request.prompt)?.[1] ?? "0".repeat(64);
  return { verdict: "APPROVE", reviewed_change_set_sha256: digest, summary: "fixture", acceptance_results: [{ acceptance_id: "AC-001", status: "PASS", evidence: ["fixture"] }, { acceptance_id: "AC-002", status: "PASS", evidence: ["fixture"] }], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], recommended_next_state: "SOL_REVIEWING", human_action: null };
}

class FailingTestSandbox implements VerificationSandbox {
  private failed = false;
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    if (executable === "npm" && args.includes("test") && !this.failed) {
      this.failed = true;
      return { exitCode: 1, signal: null, stdout: "deterministic stdout tail", stderr: "token: fake-verifier-token", stdout_bytes: 24, stderr_bytes: 27, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 3 };
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "", stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 3 };
  }
}

test("required verifier failure is bounded, redacted, persisted, and reaches the next Terra turn", async () => {
  const fixture = await createPhase4Fixture();
  try {
    const client = new FakeAgentClient([assessment(), implementation(), implementation(), review, review]);
    const result = await executeRun({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.configPath, agentClient: client, sandbox: new FailingTestSandbox() });
    assert.equal(result.state, "READY_FOR_PUBLISH");
    const implementationPrompts = client.calls.filter((call) => call.role === "implementer" && !call.read_only).map((call) => call.prompt);
    assert.equal(implementationPrompts.length, 2);
    const fixPrompt = implementationPrompts[1]!;
    assert.match(fixPrompt, /test/);
    assert.match(fixPrompt, /exit_code/);
    assert.match(fixPrompt, /FAIL/);
    assert.match(fixPrompt, /deterministic stdout tail/);
    assert.match(fixPrompt, /token: \[REDACTED\]/);
    assert.match(fixPrompt, /verification_round/);
    assert.match(fixPrompt, /remaining_implementation_iterations/);
    assert.doesNotMatch(fixPrompt, /fake-verifier-token/);

    const paths = executionPaths(fixture.state, "task", "a".repeat(64));
    const executionJson = await readFile(paths.execution, "utf8");
    const fixEvidence = await readFile(`${paths.verification}/round-001/fix-evidence.json`, "utf8");
    const agentEvents = await readFile(paths.agentEvents, "utf8");
    assert.doesNotMatch(executionJson, /fake-verifier-token/);
    assert.doesNotMatch(fixEvidence, /fake-verifier-token/);
    assert.doesNotMatch(agentEvents, /fake-verifier-token/);
    assert.match(fixEvidence, /"command_id": "test"/);
    assert.match(fixEvidence, /token: \[REDACTED\]/);
  } finally { await fixture.cleanup(); }
});
