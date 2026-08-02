import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateConfig } from "../src/config/config-validator.js";
import { validateExecutionContract } from "../src/execution/execution-validator.js";
import { prepareTask, PreparationError } from "../src/run/preparation-service.js";
import { scanInbox } from "../src/inbox/scanner.js";
import { copyTemplate, updateChecksums, writeYazlZip } from "./helpers/zip-fixture.js";

interface CommandResult { code: number; stdout: string; stderr: string; }

async function command(args: string[], cwd: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 3, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

async function fixture(): Promise<{ root: string; repo: string; remote: string; state: string; config: string; archive: string; commit: string; inbox: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "wco-phase3-test-"));
  const repo = path.join(root, "repo"); const remote = path.join(root, "remote.git");
  const state = path.join(root, "state"); const inbox = path.join(root, "inbox");
  await command(["git", "init", "--bare", remote], root);
  await command(["git", "init", "-b", "main", repo], root);
  await command(["git", "config", "user.email", "phase3@example.invalid"], repo);
  await command(["git", "config", "user.name", "Phase 3 Test"], repo);
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  await command(["git", "add", "README.md"], repo);
  await command(["git", "commit", "-m", "fixture"], repo);
  const commitResult = await command(["git", "rev-parse", "HEAD"], repo);
  assert.equal(commitResult.code, 0, commitResult.stderr);
  const commit = commitResult.stdout.trim();
  await command(["git", "remote", "add", "origin", remote], repo);
  await command(["git", "update-ref", "refs/remotes/origin/main", commit], repo);
  await cp(path.resolve("templates/task-bundle"), path.join(root, "template"), { recursive: true });
  const config = path.join(root, "config.json");
  await writeFile(config, `${JSON.stringify({ config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 2, maximum_candidates_per_scan: 100 }, repositories: { fixture: { path: repo, remote: "origin", expected_remote_urls: [remote], fetch_policy: "never" } } }, null, 2)}\n`);
  const archive = path.join(root, "wco-task-phase3.zip");
  const bundle = await copyTemplate(root);
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.task_id = "TASK-2026-003";
  manifest.schema_version = "1.2";
  manifest.repository = { id: "fixture", base_branch: "main", base_commit: commit };
  const delivery = manifest.delivery as Record<string, unknown>;
  delivery.branch_name = "codex/task-2026-003";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await updateChecksums(bundle);
  await writeYazlZip(bundle, archive);
  await mkdir(state, { recursive: true });
  await mkdir(inbox, { recursive: true });
  return { root, repo, remote, state, config, archive, commit, inbox };
}

async function withFixture(callback: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const value = await fixture();
  try { await callback(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}

test("P3-001: schema 1.2 contract validates", () => {
  const report = validateExecutionContract({
    schema_version: "1.2", task_id: "TASK-2026-003", title: "fixture",
    repository: { id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    delivery: { mode: "github_pull_request", remote: "origin", base_branch: "main", branch_name: "codex/task", draft: true, push_after: ["VERIFIER_PASS", "SOL_APPROVE"], auto_merge: false },
    git_policy: { allowed_remote: "origin", allowed_branch_prefix: "codex/", deny_direct_push_branches: ["main"], allow_force_push: false, allow_remote_branch_delete: false, allow_merge: false },
    limits: { max_internal_iterations: 1, max_review_rounds: 1, max_changed_files: 1, max_diff_lines: 1 }, allowed_paths: ["src/**"], forbidden_paths: [".git/**"],
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("P3-002: schema 1.1 is accepted by intake but blocked by prepare", async () => {
  await withFixture(async ({ root, archive, state, config }) => {
    const bundle = await copyTemplate(root);
    const manifestPath = path.join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.schema_version = "1.1";
    delete manifest.delivery; delete manifest.git_policy;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(bundle);
    const legacy = path.join(root, "wco-task-legacy.zip");
    await writeYazlZip(bundle, legacy);
    await assert.rejects(prepareTask({ archivePath: legacy, stateDirectory: state, configPath: config }), (error: unknown) => error instanceof PreparationError && error.code === "EXECUTION_CONTRACT_REQUIRED");
    void archive;
  });
});

test("P3 prepare creates an isolated clean worktree and is idempotent", async () => {
  await withFixture(async ({ archive, state, config, repo, commit }) => {
    const first = await prepareTask({ archivePath: archive, stateDirectory: state, configPath: config });
    assert.equal(first.status, "READY_FOR_CODEX");
    assert.equal(first.base_commit, commit);
    assert.equal(first.state, "READY_FOR_CODEX");
    assert.equal((await command(["git", "status", "--porcelain"], repo)).stdout, "");
    const second = await prepareTask({ archivePath: archive, stateDirectory: state, configPath: config });
    assert.deepEqual(second, first);
    const events = (await readFile(path.join(state, "runs", first.task_id, first.archive_sha256, "events.jsonl"), "utf8")).trim().split(/\n/).map((line) => JSON.parse(line) as { sequence: number });
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  });
});

test("P3 contract rejects HEAD and unsafe delivery policy", () => {
  const result = validateExecutionContract({ schema_version: "1.2", repository: { id: "repo", base_branch: "main", base_commit: "HEAD" }, delivery: { mode: "github_pull_request", remote: "origin", base_branch: "other", branch_name: "main", draft: false, push_after: ["VERIFIER_PASS"], auto_merge: true }, git_policy: { allowed_remote: "other", allowed_branch_prefix: "codex/", deny_direct_push_branches: ["main"], allow_force_push: true, allow_remote_branch_delete: false, allow_merge: true } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "BASE_COMMIT_INVALID"));
  assert.ok(result.issues.some((issue) => issue.code === "DELIVERY_CONTRACT_INVALID"));
  assert.ok(result.issues.some((issue) => issue.code === "GIT_POLICY_INVALID"));
});

test("P3 inbox scan processes a stable candidate once", async () => {
  await withFixture(async ({ archive, state, config, inbox }) => {
    const candidate = path.join(inbox, path.basename(archive));
    await cp(archive, candidate);
    const old = new Date(Date.now() - 10_000);
    await utimes(candidate, old, old);
    const configValue = { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 2, maximum_candidates_per_scan: 100 } as const;
    const first = await scanInbox({ inboxDirectory: inbox, stateDirectory: state, configPath: config, config: configValue, sleep: async () => undefined });
    assert.equal(first.ready_for_codex, 1, JSON.stringify(first));
    const second = await scanInbox({ inboxDirectory: inbox, stateDirectory: state, configPath: config, config: configValue, sleep: async () => undefined });
    assert.equal(second.skipped, 1, JSON.stringify(second));
  });
});

test("P3 config rejects unknown fields and symlink paths", async () => {
  assert.equal(validateConfig({ config_version: "1.0", extra: true }).ok, false);
  await withFixture(async ({ root, config }) => {
    const link = path.join(root, "config-link.json");
    await symlink(config, link);
    const { loadTrustedConfig } = await import("../src/config/config-loader.js");
    await assert.rejects(loadTrustedConfig(link), (error: unknown) => error instanceof Error && "code" in error && (error as { code: unknown }).code === "CONFIG_SYMLINK");
  });
});
