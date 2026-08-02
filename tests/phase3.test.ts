import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateConfig } from "../src/config/config-validator.js";
import { validateExecutionContract } from "../src/execution/execution-validator.js";
import { prepareTask, PreparationError } from "../src/run/preparation-service.js";
import { scanInbox } from "../src/inbox/scanner.js";
import { GitRunner } from "../src/git/git-runner.js";
import { ensureGitRuntime } from "../src/git/git-runtime.js";
import { createIsolatedWorktree } from "../src/git/worktree-manager.js";
import { copyTemplate, updateChecksums, writeYazlZip } from "./helpers/zip-fixture.js";

interface CommandResult { code: number; stdout: string; stderr: string; }

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true).catch(() => false);
}

async function treeContains(target: string, needle: string): Promise<boolean> {
  if (!await pathExists(target)) return false;
  const info = await lstat(target);
  if (info.isFile()) return (await readFile(target, "utf8")).includes(needle);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  for (const entry of await readdir(target)) {
    if (await treeContains(path.join(target, entry), needle)) return true;
  }
  return false;
}

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

function runCli(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli/index.ts"), ...args], {
      cwd: path.resolve("."),
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => resolve({ code: code ?? 3, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
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

test("P3-074: post-checkout hooks cannot run during worktree preparation", async () => {
  await withFixture(async ({ archive, state, config, root, repo }) => {
    const marker = path.join(root, "post-checkout-marker");
    await writeFile(path.join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf marker > ${marker}\n`, { mode: 0o700 });
    const receipt = await prepareTask({ archivePath: archive, stateDirectory: state, configPath: config });
    assert.equal(receipt.status, "READY_FOR_CODEX");
    assert.equal(await pathExists(marker), false);
  });
});

test("P3-075: external smudge filters are blocked before checkout", async () => {
  await withFixture(async ({ archive, state, config, root, repo }) => {
    const marker = path.join(root, "smudge-marker");
    const filterCommand = `printf marker > ${marker}`;
    const configured = await command(["git", "config", "filter.phase3.smudge", filterCommand], repo);
    assert.equal(configured.code, 0, configured.stderr);
    await assert.rejects(
      prepareTask({ archivePath: archive, stateDirectory: state, configPath: config }),
      (error: unknown) => error instanceof PreparationError && error.code === "GIT_CHECKOUT_FILTER_UNSAFE",
    );
    assert.equal(await pathExists(marker), false);
    assert.equal(await pathExists(path.join(state, "worktrees", "TASK-2026-003", "a".repeat(64), "repository")), false);
  });
});

test("P3-076: credential-bearing HTTP remotes are rejected without leaking the token", async () => {
  await withFixture(async ({ archive, state, config, root }) => {
    const token = "phase3-fake-token-DO-NOT-LEAK";
    const unsafe = JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>;
    const repositories = unsafe.repositories as Record<string, Record<string, unknown>>;
    repositories.fixture!.expected_remote_urls = [`https://user:${token}@github.com/example/repo.git`];
    const unsafeConfig = path.join(root, "unsafe-config.json");
    await writeFile(unsafeConfig, `${JSON.stringify(unsafe, null, 2)}\n`);
    await assert.rejects(
      prepareTask({ archivePath: archive, stateDirectory: state, configPath: unsafeConfig }),
      (error: unknown) => error instanceof PreparationError && error.code === "CONFIG_INVALID" && !error.message.includes(token),
    );
    assert.equal(await treeContains(state, token), false);
  });
});

test("P3 worktree race: a branch created after the preflight survives failed preparation", async () => {
  await withFixture(async ({ state, repo, commit }) => {
    const branchName = "codex/race";
    const raceRunner = new class extends GitRunner {
      private raced = false;
      override async run(args: readonly string[], cwd: string) {
        const result = await super.run(args, cwd);
        if (!this.raced && args.includes("show-ref") && args.includes(`refs/heads/${branchName}`)) {
          this.raced = true;
          await command(["git", "branch", branchName, commit], cwd);
        }
        return result;
      }
    }();
    const repository = {
      id: "fixture",
      configured_path: repo,
      path: repo,
      remote: "origin",
      expected_remote_urls: [],
      fetch_policy: "never" as const,
    };
    await assert.rejects(
      createIsolatedWorktree({ stateDirectory: state, taskId: "TASK-RACE", archiveSha256: "a".repeat(64), branchName, baseCommit: commit, repository, runner: raceRunner }),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: unknown }).code === "BRANCH_ALREADY_EXISTS",
    );
    const branch = await command(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repo);
    assert.equal(branch.code, 0, branch.stderr);
    assert.equal(await pathExists(path.join(state, "worktrees", "TASK-RACE", "a".repeat(64), "repository")), false);
  });
});

test("P3 CLI scan emits human output by default and one JSON object with --json", async () => {
  await withFixture(async ({ state, config, inbox }) => {
    const human = await runCli(["scan", "--inbox", inbox, "--state-dir", state, "--config", config]);
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout.startsWith("Discovered: 0"), true);
    assert.equal(human.stdout.trim().startsWith("{"), false);
    const json = await runCli(["scan", "--inbox", inbox, "--state-dir", state, "--config", config, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout) as { discovered: number }, { scan_version: "1.0", discovered: 0, unstable: 0, skipped: 0, ready_for_codex: 0, rejected: 0, blocked: 0, failed: 0, results: [] });
  });
});

test("P3-077: reference-transaction hook is disabled during branch/worktree preparation", async () => {
  await withFixture(async ({ archive, state, config, root, repo }) => {
    const marker = path.join(root, "reference-transaction-prepare-marker");
    await writeFile(path.join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\nprintf marker > ${marker}\n`, { mode: 0o700 });
    const receipt = await prepareTask({ archivePath: archive, stateDirectory: state, configPath: config });
    assert.equal(receipt.status, "READY_FOR_CODEX");
    assert.equal(await pathExists(marker), false);
  });
});

test("P3-078: reference-transaction hook is disabled during an allowlisted fetch", async () => {
  await withFixture(async ({ archive, state, config, root, repo, remote, commit }) => {
    const marker = path.join(root, "reference-transaction-fetch-marker");
    const seeded = await command(["git", "--git-dir", remote, "fetch", repo, "refs/heads/main:refs/heads/main"], root);
    assert.equal(seeded.code, 0, seeded.stderr);
    await writeFile(path.join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\nprintf marker > ${marker}\n`, { mode: 0o700 });
    const configValue = JSON.parse(await readFile(config, "utf8")) as { repositories: { fixture?: { fetch_policy: string } } };
    configValue.repositories.fixture!.fetch_policy = "always";
    await writeFile(config, `${JSON.stringify(configValue, null, 2)}\n`);
    const receipt = await prepareTask({ archivePath: archive, stateDirectory: state, configPath: config });
    assert.equal(receipt.status, "READY_FOR_CODEX");
    assert.equal(await pathExists(marker), false);
  });
});

test("P3-079: cleanup branch deletion is protected from reference-transaction hooks", async () => {
  await withFixture(async ({ archive, state, config, root, repo }) => {
    const marker = path.join(root, "reference-transaction-cleanup-marker");
    await writeFile(path.join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\nprintf marker > ${marker}\n`, { mode: 0o700 });
    class ForcedVerificationFailureRunner extends GitRunner {
      private failed = false;

      override async run(args: readonly string[], cwd: string) {
        const result = await super.run(args, cwd);
        if (!this.failed && args[0] === "status" && args[1] === "--porcelain" && cwd.includes(path.join("worktrees", "TASK-2026-003"))) {
          this.failed = true;
          return { ...result, exitCode: 1, stderr: "forced verification failure" };
        }
        return result;
      }
    }
    const runner = new ForcedVerificationFailureRunner(process.env, path.join(state, "git-runtime"));
    await assert.rejects(
      prepareTask({ archivePath: archive, stateDirectory: state, configPath: config, runner }),
      (error: unknown) => error instanceof PreparationError && error.code === "WORKTREE_VERIFY_FAILED",
    );
    const branch = await command(["git", "show-ref", "--verify", "--quiet", "refs/heads/codex/task-2026-003"], repo);
    assert.equal(branch.code, 1, branch.stderr);
    assert.equal(await pathExists(marker), false);
  });
});

test("P3-080: every GitCommandResult from a runtime-bound runner carries hook protection", async () => {
  await withFixture(async ({ state, repo }) => {
    const runtime = await ensureGitRuntime(state);
    const runner = new GitRunner(process.env, runtime.root);
    const result = await runner.run(["rev-parse", "--is-inside-work-tree"], repo);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.args.slice(0, 4), ["-c", `core.hooksPath=${runtime.hooksPath}`, "-c", "core.fsmonitor=false"]);
  });
});
