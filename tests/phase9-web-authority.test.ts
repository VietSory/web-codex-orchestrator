import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import yazl from "yazl";
import { canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readArtifactRegistration } from "../src/web-authority/registry.js";
import { validateWebResponseEnvelope } from "../src/web-authority/response-validator.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

const execFile = promisify(execFileCallback);
const sha256 = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function specSet(bundlePath: string, taskId: string, runId: string, archiveSha: string): Promise<string> {
  const names = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json"];
  const files: Array<{ name: string; buffer: Buffer }> = [];
  for (const name of names) files.push({ name, buffer: await fs.readFile(path.join(bundlePath, name)) });
  files.push({ name: "README.md", buffer: Buffer.from([
    "# Task Specification Overview", "", `Task ID: \`${taskId}\``, `Run ID: \`${runId}\``, `Archive SHA-256: \`${archiveSha}\``, "",
    "This directory contains the task specification and spec-lock.",
    "Files copied from the accepted task bundle are preserved verbatim.",
    "The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",
  ].join("\n") + "\n") });
  const input = files.sort((a, b) => lexical(a.name, b.name)).map((file) => ({ path: `task/${file.name}`, sha256: sha256(file.buffer), size_bytes: file.buffer.byteLength }));
  return sha256(canonicalJsonBuffer(input));
}

interface Fixture {
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

async function createFixture(): Promise<Fixture> {
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
  const rawInventory = await git(repo, "ls-tree", "-rz", "-l", "--full-tree", baseCommit);
  const inventory = rawInventory.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const meta = record.slice(0, tab).match(/^([0-9]{6}) (blob|commit) ([a-f0-9]{40}) ([0-9-]+)$/)!;
    return { path: record.slice(tab + 1), mode: meta[1]!, type: meta[2]! as "blob" | "commit", object_sha: meta[3]!, size_bytes: meta[4] === "-" ? null : Number(meta[4]) };
  }).sort((a, b) => lexical(a.path, b.path));
  const appObjectSha = inventory.find((entry) => entry.path === "app.txt")!.object_sha;

  await fs.cp(path.resolve("templates/task-bundle"), bundle, { recursive: true });
  const taskId = "TASK-P9-001";
  const archiveSha = "a".repeat(64);
  const runId = `${taskId}:${archiveSha}`;
  const specSetSha = await specSet(bundle, taskId, runId, archiveSha);
  const now = "2026-08-08T00:00:00.000Z";
  await fs.mkdir(path.join(state, "runs", taskId, archiveSha), { recursive: true });
  await fs.writeFile(path.join(state, "runs", taskId, archiveSha, "run.json"), JSON.stringify({
    run_version: "1.0", run_id: runId, status: "READY_FOR_CODEX", task_id: taskId, archive_sha256: archiveSha, bundle_schema_version: "1.3",
    repository_id: "fixture", repository_path: repo, remote: "origin", remote_url: "https://github.com/example/fixture.git", base_branch: "main", base_commit: baseCommit,
    branch_name: "codex/task-p9", worktree_path: repo, accepted_bundle_path: bundle, state: "READY_FOR_CODEX", checks: [], errors: [], created_at: now, updated_at: now,
  }, null, 2));
  const config = path.join(root, "config.json");
  await fs.writeFile(config, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 2000, stable_age_ms: 3000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: { fixture: { path: repo, remote: "origin", expected_remote_urls: ["https://github.com/example/fixture.git"], fetch_policy: "never" } },
  }, null, 2));
  return { root, state, repo, bundle, config, runId, taskId, archiveSha, baseCommit, treeSha, inventory, appObjectSha, specSetSha };
}

interface PackOptions { wrongPreimage?: boolean; wrongInventory?: boolean; corruptPayloadAfterChecksums?: boolean; }
async function buildPack(fixture: Fixture, options: PackOptions = {}): Promise<string> {
  const entries = new Map<string, Buffer>();
  const addJson = (name: string, value: unknown): void => entries.set(name, canonicalJsonBuffer(value));
  const before = await fs.readFile(path.join(fixture.repo, "app.txt"));
  const preimage = options.wrongPreimage ? "b".repeat(64) : sha256(before);
  const inventory = fixture.inventory.map((entry) => ({ ...entry }));
  if (options.wrongInventory) inventory[0] = { ...inventory[0]!, object_sha: "c".repeat(40) };
  addJson("repository-inventory.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, entries: inventory });
  addJson("read-coverage.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, reads: [{ path: "app.txt", object_sha: fixture.appObjectSha, coverage: "full" }] });
  addJson("project-map.json", { schema_version: "2.0", repository_tree_sha: fixture.treeSha, nodes: [{ path: "app.txt", role: "fixture" }] });
  addJson("source-receipts.json", { schema_version: "2.0", receipts: [{ source_id: "SRC-001", source_type: "document", locator: "fixture://requirements", accessed_at: "2026-08-08T00:00:00.000Z", content_sha256: sha256("requirements"), authority: "primary" }] });
  addJson("preimages.json", { schema_version: "2.0", entries: [{ path: "app.txt", sha256: preimage }] });
  addJson("architecture-lock.json", { schema_version: "2.0", spec_set_sha256: fixture.specSetSha, decisions: [{ id: "ARCH-001", decision: "replace fixture content" }] });
  addJson("acceptance-lock.json", { schema_version: "2.0", spec_set_sha256: fixture.specSetSha, criteria: [{ id: "ACC-001", text: "app.txt contains after" }] });
  addJson("prohibited-changes.json", { schema_version: "2.0", paths: [".git/**"], rules: ["no redesign"] });
  const payload = Buffer.from("after\n");
  entries.set("payload/OP-001.bin", payload);
  addJson("operations.json", { schema_version: "2.0", operations: [{ op_id: "OP-001", kind: "replace_file", path: "app.txt", preimage_sha256: preimage, payload_entry: "payload/OP-001.bin", payload_sha256: sha256(payload) }] });
  const binding = (name: string): string => sha256(entries.get(name)!);
  addJson("implementation-pack.json", {
    schema_version: "2.0", kind: "wco-web-implementation-pack", pack_id: "PACK-P9-001", run_id: fixture.runId, task_id: fixture.taskId, task_bundle_sha256: fixture.archiveSha,
    repository: { id: "fixture", base_branch: "main", base_commit: fixture.baseCommit, tree_sha: fixture.treeSha },
    bindings: {
      spec_set_sha256: fixture.specSetSha,
      repository_inventory_sha256: binding("repository-inventory.json"), read_coverage_sha256: binding("read-coverage.json"), project_map_sha256: binding("project-map.json"),
      source_receipts_sha256: binding("source-receipts.json"), preimages_sha256: binding("preimages.json"), architecture_lock_sha256: binding("architecture-lock.json"),
      acceptance_lock_sha256: binding("acceptance-lock.json"), prohibited_changes_sha256: binding("prohibited-changes.json"), operations_sha256: binding("operations.json"),
    },
    created_at: "2026-08-08T00:00:00.000Z",
  });
  const checksumEntries = [...entries.entries()].sort(([a], [b]) => lexical(a, b)).map(([entryPath, content]) => ({ path: entryPath, sha256: sha256(content), size_bytes: content.byteLength }));
  addJson("checksums.json", { schema_version: "2.0", algorithm: "sha256", entries: checksumEntries });
  if (options.corruptPayloadAfterChecksums) entries.set("payload/OP-001.bin", Buffer.from("corrupt\n"));
  const archivePath = path.join(fixture.root, `pack-${crypto.randomUUID()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of [...entries.entries()].sort(([a], [b]) => lexical(a, b))) zip.addBuffer(content, name, { compress: false });
    zip.end();
    const output = (await import("node:fs")).createWriteStream(archivePath, { flags: "wx" });
    zip.outputStream.pipe(output);
    zip.outputStream.once("error", reject);
    output.once("error", reject);
    output.once("close", () => resolve());
  });
  return archivePath;
}

test("P9-AUTH-001 valid pack is bounded, snapshot-bound and registerable", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  assert.equal(pack.manifest.repository.tree_sha, fixture.treeSha);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive, now: () => new Date("2026-08-08T00:01:00.000Z") });
  assert.equal(record.artifact_sha256, pack.archive_sha256);
  const stored = await readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  assert.equal(stored?.pack_id, "PACK-P9-001");
  const adopted = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive, now: () => new Date("2026-08-08T00:02:00.000Z") });
  assert.equal(adopted.artifact_sha256, record.artifact_sha256);
});

test("P9-AUTH-002 checksum tamper is rejected before authority registration", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPack(fixture, { corruptPayloadAfterChecksums: true });
  await assert.rejects(() => readAndValidateWebImplementationPack(archive), (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_CHECKSUM_MISMATCH");
});

test("P9-AUTH-003 self-consistent but false preimage cannot create authority", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPack(fixture, { wrongPreimage: true });
  await assert.rejects(() => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }), (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_PREIMAGE_INVALID");
});

test("P9-AUTH-004 Web inventory must equal the exact Git tree inventory", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPack(fixture, { wrongInventory: true });
  await assert.rejects(() => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }), (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH");
});

test("P9-AUTH-005 dirty worktree invalidates a Web implementation pack", async (t) => {
  const fixture = await createFixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPack(fixture);
  await fs.writeFile(path.join(fixture.repo, "untracked.txt"), "drift\n");
  await assert.rejects(() => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }), (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH");
});

test("P9-AUTH-006 response envelope is closed-world and exact-artifact-bound", () => {
  const valid = validateWebResponseEnvelope({ schema_version: "2.0", kind: "wco-web-response", run_id: `TASK:${"a".repeat(64)}`, response_id: "RESP-001", in_reply_to_artifact_sha256: "b".repeat(64), decision: "REVISE", payload_sha256: "c".repeat(64), created_at: "2026-08-08T00:00:00.000Z" });
  assert.equal(valid.decision, "REVISE");
  assert.throws(() => validateWebResponseEnvelope({ ...valid, loose_patch: "override" }), WebAuthorityError);
});
