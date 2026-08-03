import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCompatibleCodexCliVersion,
  codexCliArgs,
  detectCodexCliVersion,
  PINNED_CODEX_CLI_VERSION,
  resolveCodexRuntime,
} from "../src/runtime/codex-runtime.js";
import { loadExecutionConfig } from "../src/execution/execution-config.js";
import { ExecutionError } from "../src/execution/errors.js";
import { fakeResolvedCodexRuntime } from "./helpers/codex-runtime-fixture.js";

test("P4-111: pinned version parser accepts only 0.145.0", () => {
  assert.equal(PINNED_CODEX_CLI_VERSION, "0.145.0");
  assert.equal(detectCodexCliVersion("codex-cli 0.145.0\n"), "0.145.0");
  assert.equal(assertCompatibleCodexCliVersion("codex-cli 0.145.0\n"), "0.145.0");
  for (const output of ["codex-cli 0.146.0\n", "Codex CLI unavailable\n"]) {
    assert.throws(
      () => assertCompatibleCodexCliVersion(output),
      (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_RUNTIME_VERSION_MISMATCH",
    );
  }
});

test("P4-112: runtime resolves the bundled pinned package and launcher", async () => {
  const runtime = await resolveCodexRuntime({ source: "bundled" });
  assert.equal(runtime.source, "bundled");
  assert.equal(runtime.package_version, "0.145.0");
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.prefix_args.length, 1);
  assert.equal(runtime.prefix_args[0], runtime.launcher_path);
  assert.equal(path.isAbsolute(runtime.launcher_path), true);
  assert.equal((await stat(runtime.launcher_path)).isFile(), true);
});

test("P4-113: a global codex executable is ignored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-codex-global-"));
  const fakeBin = path.join(root, "bin");
  const fakeCodex = path.join(fakeBin, process.platform === "win32" ? "codex.cmd" : "codex");
  const executionMarker = path.join(root, "global-codex-was-executed");
  const previousPath = process.env.PATH;
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin, { recursive: true }));
    await writeFile(fakeCodex, `#!/bin/sh\nprintf executed > ${JSON.stringify(executionMarker)}\nprintf 'codex-cli 999.0.0\\n'\n`);
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    const runtime = await resolveCodexRuntime({ source: "bundled" });
    assert.equal(runtime.package_version, "0.145.0");
    assert.equal(runtime.source, "bundled");
    assert.match(runtime.launcher_path, /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    // The fake executable is intentionally never spawned; resolution uses the package itself.
    await assert.rejects(() => stat(executionMarker));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

function validPhase4Config(runtime: Record<string, unknown>): Record<string, unknown> {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: { repo: { path: "/tmp/repo", remote: "origin", expected_remote_urls: ["file:///tmp/repo"], fetch_policy: "never" } },
    runtime,
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: { maximum_implementation_iterations: 1, maximum_internal_review_rounds: 1, maximum_sol_review_rounds: 1, maximum_total_agent_turns: 4, maximum_turn_seconds: 60, maximum_total_seconds: 120, maximum_total_input_tokens: 1000, maximum_total_output_tokens: 1000 },
    },
    verification: { allowed_executables: ["node"], allowed_environment_keys: [], maximum_command_seconds: 1, maximum_output_bytes: 1000, allowed_generated_paths: [] },
  };
}

test("P4-114: invalid runtime config has EXECUTION_CONFIG_INVALID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-codex-config-"));
  try {
    const invalidValues = [
      { source: "global" },
      { source: "path" },
      { source: "bundled", codex_executable: "/usr/bin/codex" },
      { source: "bundled", codex_home: "relative/.codex" },
      { source: "bundled", unknown: true },
    ];
    for (const runtime of invalidValues) {
      const configPath = path.join(root, `${JSON.stringify(runtime).length}.json`);
      await writeFile(configPath, `${JSON.stringify(validPhase4Config(runtime))}\n`);
      await assert.rejects(
        () => loadExecutionConfig(configPath),
        (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P4-115: CLI args retain the trusted launcher prefix", () => {
  const runtime = fakeResolvedCodexRuntime();
  assert.deepEqual(codexCliArgs(runtime, ["--version"]), [runtime.launcher_path, "--version"]);
});
