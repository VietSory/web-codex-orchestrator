import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import { loadExecutionConfig } from "../src/execution/execution-config.js";
import { executeRun } from "../src/execution/execution-service.js";
import { CodexVerificationSandbox } from "../src/verifier/codex-sandbox.js";
import { ExecutionError } from "../src/execution/errors.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { updateChecksums } from "./helpers/zip-fixture.js";
import { createPhase4Fixture } from "./helpers/phase4-fixture.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.WCO_RUN_CODEX_INTEGRATION === "1";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" } });
  return String(result.stdout).trim();
}

test("optional real Codex execution reaches READY_FOR_PUBLISH without publishing", { skip: !enabled }, async (context) => {
  if (!enabled) { context.skip("WCO_RUN_CODEX_INTEGRATION is not enabled."); return; }
  const executable = process.env.WCO_CODEX_EXECUTABLE;
  if (!executable) throw new Error("CODEX_RUNTIME_NOT_FOUND: WCO_CODEX_EXECUTABLE is required when real integration is enabled.");
  const fixture = await createPhase4Fixture();
  try {
    const manifestPath = `${fixture.bundle}/manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest as { title?: string }).title = "Add and test one pure function";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(`${fixture.bundle}/REQUEST.md`, "Add a pure add(a, b) function to src/index.mjs and test it.\n");
    await writeFile(`${fixture.bundle}/PLAN.md`, "Implement the smallest pure function change and verify it deterministically.\n");
    await writeFile(`${fixture.bundle}/RULES.md`, "Do not commit, push, execute payloads, or use network access.\n");
    await writeFile(`${fixture.bundle}/validation.json`, JSON.stringify({ commands: [{ id: "test", executable: "node", args: ["-e", "import('./src/index.mjs').then(({ add }) => { if (add(2, 3) !== 5) process.exit(1); })"], cwd: ".", environment: {}, required: true, timeout_seconds: 60, maximum_output_bytes: 65_536 }] }, null, 2));
    await updateChecksums(fixture.bundle);
    await writeFile(`${fixture.configPath}`, JSON.stringify({
      config_version: "1.0",
      inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
      repositories: { repo: { path: fixture.worktree, remote: "origin", expected_remote_urls: ["file:///tmp/unused"], fetch_policy: "never" } },
      runtime: { codex_executable: executable, ...(process.env.WCO_CODEX_HOME ? { codex_home: process.env.WCO_CODEX_HOME } : {}) },
      agents: {
        implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
        internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
        final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
        limits: { maximum_implementation_iterations: 2, maximum_internal_review_rounds: 1, maximum_sol_review_rounds: 1, maximum_total_agent_turns: 8, maximum_turn_seconds: 900, maximum_total_seconds: 3600, maximum_total_input_tokens: 200_000, maximum_total_output_tokens: 50_000 },
      },
      verification: { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 60, maximum_output_bytes: 65_536, allowed_generated_paths: [] },
    }, null, 2));
    const config = await loadExecutionConfig(fixture.configPath);
    const runtime = await resolveCodexRuntime(config.runtime, fixture.state);
    const beforeHead = await git(fixture.worktree, ["rev-parse", "HEAD"]);
    const beforeRemoteRefs = await git(fixture.worktree, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"]);
    const result = await executeRun({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.configPath, config, agentClient: new CodexSdkAgentClient(runtime), sandbox: new CodexVerificationSandbox(runtime) });
    assert.equal(result.state, "READY_FOR_PUBLISH");
    assert.equal(await git(fixture.worktree, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(await git(fixture.worktree, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"]), beforeRemoteRefs);
    assert.equal(await git(fixture.worktree, ["ls-files", "payload/marker"]), "");
  } catch (error) {
    if (error instanceof ExecutionError && error.code === "CODEX_AUTH_UNAVAILABLE") throw new Error("CODEX_AUTH_UNAVAILABLE: Codex login status failed.");
    throw error;
  } finally {
    await fixture.cleanup();
  }
});
