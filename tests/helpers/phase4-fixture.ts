import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { updateChecksums } from "../helpers/zip-fixture.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(result.stdout).trim();
}

export interface Phase4Fixture {
  root: string;
  state: string;
  bundle: string;
  worktree: string;
  configPath: string;
  runId: string;
  base: string;
  cleanup(): Promise<void>;
}

/** Creates only local temporary state. It never creates a remote or invokes
 * any payload/validation command. */
export async function createPhase4Fixture(): Promise<Phase4Fixture> {
  const rootRaw = await mkdtemp(path.join(os.tmpdir(), "wco-p4-fixture-"));
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(rootRaw);
  try {
    const state = path.join(root, "state");
    const archiveSha256 = "a".repeat(64);
    const bundle = path.join(state, "accepted", "task", archiveSha256);
    const worktree = path.join(state, "worktrees", "task", archiveSha256, "repository");
    await mkdir(bundle, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await git(worktree, ["init", "-b", "main"]);
    await git(worktree, ["config", "user.email", "p4-fixture@example.invalid"]);
    await git(worktree, ["config", "user.name", "P4 Fixture"]);
    await writeFile(path.join(worktree, "README.md"), "fixture\n");
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await writeFile(path.join(worktree, "src", "index.mjs"), "export function identity(value) { return value; }\n");
    await git(worktree, ["add", "README.md", "src/index.mjs"]);
    await git(worktree, ["commit", "-m", "fixture"]);
    const base = await git(worktree, ["rev-parse", "HEAD"]);
    await git(worktree, ["checkout", "-b", "codex/phase4-fixture"]);
    await cp(path.resolve("templates/task-bundle"), bundle, { recursive: true });
    const manifestPath = path.join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    (manifest.repository as Record<string, unknown>).id = "repo";
    (manifest.repository as Record<string, unknown>).base_commit = base;
    (manifest.delivery as Record<string, unknown>).branch_name = "codex/phase4-fixture";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(bundle);
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      config_version: "1.0",
      inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
      repositories: { repo: { path: worktree, remote: "origin", expected_remote_urls: ["file:///tmp/unused"], fetch_policy: "never" } },
      runtime: { source: "bundled" },
      agents: {
        implementer: { model: "terra", reasoning_effort: "high" },
        internal_reviewer: { model: "terra", reasoning_effort: "high" },
        final_reviewer: { model: "sol", reasoning_effort: "high" },
        limits: { maximum_implementation_iterations: 4, maximum_internal_review_rounds: 4, maximum_sol_review_rounds: 4, maximum_total_agent_turns: 20, maximum_turn_seconds: 60, maximum_total_seconds: 120, maximum_total_input_tokens: 100000, maximum_total_output_tokens: 100000 },
      },
      verification: { allowed_executables: ["npm"], allowed_environment_keys: ["CI"], maximum_command_seconds: 600, maximum_output_bytes: 4194304, allowed_generated_paths: ["dist/**"] },
    }, null, 2));
    const runDirectory = path.join(state, "runs", "task", archiveSha256);
    await mkdir(runDirectory, { recursive: true });
    const runId = `task:${archiveSha256}`;
    await writeFile(path.join(runDirectory, "run.json"), JSON.stringify({ run_version: "1.0", run_id: runId, status: "READY_FOR_CODEX", task_id: "task", archive_sha256: archiveSha256, bundle_schema_version: "1.3", repository_id: "repo", repository_path: worktree, remote: "origin", remote_url: "file:///tmp/unused", base_branch: "main", base_commit: base, branch_name: "codex/phase4-fixture", worktree_path: worktree, accepted_bundle_path: bundle, state: "READY_FOR_CODEX", checks: ["bundle-intake-accepted"], errors: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
    return { root, state, bundle, worktree, configPath, runId, base, cleanup: async () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
