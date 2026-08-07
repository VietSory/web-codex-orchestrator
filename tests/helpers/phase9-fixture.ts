import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import yazl from "yazl";
import { canonicalJsonBuffer } from "../../src/result-bundle/canonical-json.js";

const execFile = promisify(execFileCallback);
export const sha256 = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function computeSpecSet(bundlePath: string, taskId: string, runId: string, archiveSha: string): Promise<string> {
  const names = [
    "manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md",
    "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json",
  ];
  const files: Array<{ name: string; buffer: Buffer }> = [];
  for (const name of names) files.push({ name, buffer: await fs.readFile(path.join(bundlePath, name)) });
  files.push({
    name: "README.md",
    buffer: Buffer.from([
      "# Task Specification Overview",
      "",
      `Task ID: \`${taskId}\``,
      `Run ID: \`${runId}\``,
      `Archive SHA-256: \`${archiveSha}\``,
      "",
      "This directory contains the task specification and spec-lock.",
      "Files copied from the accepted task bundle are preserved verbatim.",
      "The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",
    ].join("\n") + "\n", "utf8"),
  });
  const authoritative = files
    .sort((a, b) => lexical(a.name, b.name))
    .map((file) => ({ path: `task/${file.name}`, sha256: sha256(file.buffer), size_bytes: file.buffer.byteLength }));
  return sha256(canonicalJsonBuffer(authoritative));
}

export interface Phase9Fixture {
  root: string;
  state: string;
  repo: string;
  bundle: string;
  config: string;
  runId: string;
  taskId: string;
  archiveSha: string;
  baseCommit: string;
  treeSha: string;
  inventory: Array<{ path: string; mode: string; type: "blob" | "commit"; object_sha: string; size_bytes: number | null }>;
  appObjectSha: string;
  specSetSha: string;
}

export async function createPhase9Fixture(): Promise<Phase9Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p9-"));
  const state = path.join(root, "state");
  const repo = path.join(state, "repo");
  const bundle = path.join(state, "accepted-bundle");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "WCO Test");
  await git(repo, "config", "user.email", "wco@example.invalid");
  await fs.writeFile(path.join(repo, "app.txt"), "before\n");
  await fs.writeFile(path.join(repo, "README.md"), "fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const baseCommit = (await git(repo, "rev-parse", "HEAD")).trim();
  const treeSha = (await git(repo, "rev-parse", `${baseCommit}^{tree}`)).trim();
  const raw = await git(repo, "ls-tree", "-rz", "-l", "--full-tree", baseCommit);
  const inventory = raw.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const match = record.slice(0, tab).match(/^([0-9]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9-]+)$/);
    if (!match) throw new Error(`Unparseable git inventory fixture record: ${record}`);
    return {
      path: record.slice(tab + 1),
      mode: match[1]!,
      type: match[2]! as "blob" | "commit",
      object_sha: match[3]!,
      size_bytes: match[4] === "-" ? null : Number(match[4]),
    };
  }).sort((a, b) => lexical(a.path, b.path));
  const appObjectSha = inventory.find((entry) => entry.path === "app.txt")?.object_sha;
  if (!appObjectSha) throw new Error("Fixture app.txt is missing from git inventory.");

  await fs.cp(path.resolve("templates/task-bundle"), bundle, { recursive: true });
  const taskId = "TASK-P9-001";
  const archiveSha = "a".repeat(64);
  const runId = `${taskId}:${archiveSha}`;
  const specSetSha = await computeSpecSet(bundle, taskId, runId, archiveSha);
  const now = "2026-08-08T00:00:00.000Z";
  const runDirectory = path.join(state, "runs", taskId, archiveSha);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(runDirectory, "run.json"), JSON.stringify({
    run_version: "1.0",
    run_id: runId,
    status: "READY_FOR_CODEX",
    task_id: taskId,
    archive_sha256: archiveSha,
    bundle_schema_version: "1.3",
    repository_id: "fixture",
    repository_path: repo,
    remote: "origin",
    remote_url: "https://github.com/example/fixture.git",
    base_branch: "main",
    base_commit: baseCommit,
    branch_name: "codex/task-p9",
    worktree_path: repo,
    accepted_bundle_path: bundle,
    state: "READY_FOR_CODEX",
    checks: [],
    errors: [],
    created_at: now,
    updated_at: now,
  }, null, 2));

  const config = path.join(root, "config.json");
  await fs.writeFile(config, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 2000, stable_age_ms: 3000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: {
      fixture: {
        path: repo,
        remote: "origin",
        expected_remote_urls: ["https://github.com/example/fixture.git"],
        fetch_policy: "never",
      },
    },
  }, null, 2));

  return { root, state, repo, bundle, config, runId, taskId, archiveSha, baseCommit, treeSha, inventory, appObjectSha, specSetSha };
}

export interface Phase9PackOptions {
  wrongPreimage?: boolean;
  wrongInventory?: boolean;
  corruptPayloadAfterChecksums?: boolean;
}

export async function buildPhase9Pack(fixture: Phase9Fixture, options: Phase9PackOptions = {}): Promise<string> {
  const entries = new Map<string, Buffer>();
  const addJson = (name: string, value: unknown): void => { entries.set(name, canonicalJsonBuffer(value)); };
  const before = await fs.readFile(path.join(fixture.repo, "app.txt"));
  const preimage = options.wrongPreimage ? "b".repeat(64) : sha256(before);
  const inventory = fixture.inventory.map((entry) => ({ ...entry }));
  if (options.wrongInventory && inventory.length > 0) inventory[0] = { ...inventory[0]!, object_sha: "c".repeat(40) };

  addJson("repository-inventory.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, entries: inventory });
  addJson("read-coverage.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, reads: [{ path: "app.txt", object_sha: fixture.appObjectSha, coverage: "full" }] });
  addJson("project-map.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, nodes: [{ path: "app.txt", role: "fixture" }] });
  addJson("source-receipts.json", { schema_version: "2.0", receipts: [{ source_id: "SRC-001", source_type: "document", locator: "fixture://requirements", accessed_at: "2026-08-08T00:00:00.000Z", content_sha256: sha256("requirements"), authority: "primary" }] });
  addJson("preimages.json", { schema_version: "2.0", entries: [{ path: "app.txt", sha256: preimage }] });
  addJson("architecture-lock.json", { schema_version: "2.0", spec_set_sha256: fixture.specSetSha, decisions: [{ id: "ARCH-001", decision: "replace fixture content" }] });
  addJson("acceptance-lock.json", { schema_version: "2.0", spec_set_sha256: fixture.specSetSha, criteria: [{ id: "ACC-001", text: "app.txt contains after" }] });
  addJson("prohibited-changes.json", { schema_version: "2.0", paths: [".git/**"], rules: ["no redesign"] });

  const payload = Buffer.from("after\n", "utf8");
  entries.set("payload/OP-001.bin", payload);
  addJson("operations.json", { schema_version: "2.0", operations: [{
    op_id: "OP-001",
    kind: "replace_file",
    path: "app.txt",
    preimage_sha256: preimage,
    payload_entry: "payload/OP-001.bin",
    payload_sha256: sha256(payload),
  }] });

  const binding = (name: string): string => sha256(entries.get(name)!);
  addJson("implementation-pack.json", {
    schema_version: "2.0",
    kind: "wco-web-implementation-pack",
    pack_id: "PACK-P9-001",
    run_id: fixture.runId,
    task_id: fixture.taskId,
    task_bundle_sha256: fixture.archiveSha,
    repository: { id: "fixture", base_branch: "main", base_commit: fixture.baseCommit, tree_sha: fixture.treeSha },
    bindings: {
      spec_set_sha256: fixture.specSetSha,
      repository_inventory_sha256: binding("repository-inventory.json"),
      read_coverage_sha256: binding("read-coverage.json"),
      project_map_sha256: binding("project-map.json"),
      source_receipts_sha256: binding("source-receipts.json"),
      preimages_sha256: binding("preimages.json"),
      architecture_lock_sha256: binding("architecture-lock.json"),
      acceptance_lock_sha256: binding("acceptance-lock.json"),
      prohibited_changes_sha256: binding("prohibited-changes.json"),
      operations_sha256: binding("operations.json"),
    },
    created_at: "2026-08-08T00:00:00.000Z",
  });

  const checksums = [...entries.entries()]
    .sort(([a], [b]) => lexical(a, b))
    .map(([entryPath, content]) => ({ path: entryPath, sha256: sha256(content), size_bytes: content.byteLength }));
  addJson("checksums.json", { schema_version: "2.0", algorithm: "sha256", entries: checksums });
  if (options.corruptPayloadAfterChecksums) entries.set("payload/OP-001.bin", Buffer.from("corrupt\n", "utf8"));

  const archivePath = path.join(fixture.root, `pack-${crypto.randomUUID()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of [...entries.entries()].sort(([a], [b]) => lexical(a, b))) zip.addBuffer(content, name, { compress: false });
    const output = fsSync.createWriteStream(archivePath, { flags: "wx" });
    zip.outputStream.once("error", reject);
    output.once("error", reject);
    output.once("close", resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
  return archivePath;
}
