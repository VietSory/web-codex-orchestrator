import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { WebAuthorityError, type ArtifactRegistrationRecord, type WebAuthorityLimits, type WebImplementationPack } from "./contracts.js";
import { readAndValidateWebImplementationPack } from "./pack-reader.js";
import { registerWebImplementationPackArtifact } from "./registry.js";
import { computeAcceptedTaskSpecSetSha256, readBoundedStableAuthorityFile } from "./task-spec-authority.js";

interface InventoryEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  object_sha: string;
  size_bytes: number | null;
}
interface InventoryDocument {
  schema_version: "2.0";
  repository_tree_sha: string;
  entries: InventoryEntry[];
}
interface ReadCoverageDocument {
  schema_version: "2.0";
  repository_tree_sha: string;
  reads: Array<{ path: string; object_sha: string; coverage: "full" | "partial" }>;
}

function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(data: Buffer): string { return crypto.createHash("sha256").update(data).digest("hex"); }
function cleanProcessEnvironment(): Record<string, string> {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"];
  const result: Record<string, string> = {};
  for (const key of keep) if (typeof process.env[key] === "string") result[key] = process.env[key]!;
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_OPTIONAL_LOCKS = "0";
  return result;
}

async function runGit(cwd: string, args: string[], maximumBytes = 16 * 1024 * 1024): Promise<string> {
  const result = await spawnBounded({ executable: "git", args: ["-C", cwd, ...args], environment: cleanProcessEnvironment(), timeoutMs: 15_000, stdoutMaxBytes: maximumBytes, stderrMaxBytes: 65_536, shell: false });
  if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || result.stdoutTruncated) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Git attestation failed for '${args.join(" ")}': ${result.stderr.trim() || "non-zero/truncated result"}`);
  return result.stdout;
}

function parsePackJson<T>(pack: WebImplementationPack, name: string): T {
  const bytes = pack.entries.get(name);
  if (!bytes) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Missing '${name}'.`);
  try { return JSON.parse(bytes.toString("utf8")) as T; }
  catch (error) { throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Invalid JSON in '${name}': ${error instanceof Error ? error.message : String(error)}`); }
}

function parseGitInventory(raw: string): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "git ls-tree returned an unparseable record.");
    const meta = record.slice(0, tab);
    const filePath = record.slice(tab + 1);
    const match = meta.match(/^([0-9]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9-]+)$/);
    if (!match) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Unsupported git tree entry '${meta}'.`);
    entries.push({ path: filePath, mode: match[1]!, type: match[2]! as "blob" | "commit", object_sha: match[3]!, size_bytes: match[4] === "-" ? null : Number(match[4]) });
  }
  return entries.sort((a, b) => lexical(a.path, b.path));
}

function validateInventory(pack: WebImplementationPack, actual: InventoryEntry[]): Map<string, InventoryEntry> {
  const document = parsePackJson<InventoryDocument>(pack, "repository-inventory.json");
  if (document.schema_version !== "2.0" || document.repository_tree_sha !== pack.manifest.repository.tree_sha || !Array.isArray(document.entries)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "repository-inventory.json has invalid snapshot binding.");
  const expected = [...document.entries].sort((a, b) => lexical(a.path, b.path));
  if (expected.length !== actual.length) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Repository inventory count mismatch: Web=${expected.length}, Git=${actual.length}.`);
  const map = new Map<string, InventoryEntry>();
  for (let index = 0; index < actual.length; index += 1) {
    const web = expected[index]!;
    const git = actual[index]!;
    if (web.path !== git.path || web.mode !== git.mode || web.type !== git.type || web.object_sha !== git.object_sha || web.size_bytes !== git.size_bytes) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Repository inventory diverges from Git at '${web.path || git.path}'.`);
    if (map.has(web.path)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Duplicate inventory path '${web.path}'.`);
    map.set(web.path, web);
  }
  return map;
}

function validateReadCoverage(pack: WebImplementationPack, inventory: Map<string, InventoryEntry>): void {
  const document = parsePackJson<ReadCoverageDocument>(pack, "read-coverage.json");
  if (document.schema_version !== "2.0" || document.repository_tree_sha !== pack.manifest.repository.tree_sha || !Array.isArray(document.reads)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "read-coverage.json has invalid snapshot binding.");
  const seen = new Set<string>();
  for (const read of document.reads) {
    const entry = inventory.get(read.path);
    if (!entry || entry.object_sha !== read.object_sha || !["full", "partial"].includes(read.coverage) || seen.has(read.path)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Read coverage does not bind an exact inventory entry: '${read.path}'.`);
    seen.add(read.path);
  }
}

function assertWorktreeContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Operation path escapes the worktree: ${candidate}`);
}

async function readWorktreePreimage(worktreePath: string, relativePath: string): Promise<Buffer | null> {
  const root = await fs.realpath(worktreePath);
  const target = path.resolve(root, ...relativePath.split("/"));
  assertWorktreeContained(root, target);
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      // A create_file target may have one or more missing parent directories.
      // Returning null is still fail-closed for replace/delete because their
      // exact preimage checks below require existing bytes.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Cannot inspect operation preimage '${relativePath}'.`);
    }
    if (stat.isSymbolicLink()) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Operation path crosses a symbolic link: '${relativePath}'.`);
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Operation ancestor is not a directory: '${relativePath}'.`);
    if (final) return await readBoundedStableAuthorityFile(current, 8_388_608, "WEB_AUTHORITY_PREIMAGE_INVALID", `operation preimage '${relativePath}'`);
  }
  return null;
}

async function validateOperationPreimages(pack: WebImplementationPack, worktreePath: string): Promise<void> {
  for (const operation of pack.operations.operations) {
    const current = await readWorktreePreimage(worktreePath, operation.path);
    if (operation.kind === "create_file") {
      if (current !== null) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `create_file target already exists at the locked snapshot: '${operation.path}'.`);
      continue;
    }
    if (!current || sha256(current) !== operation.preimage_sha256) throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Exact preimage mismatch for '${operation.path}'.`);
  }
}

export async function registerWebImplementationPack(options: { runId: string; stateDirectory: string; configPath: string; archivePath: string; limits?: Partial<WebAuthorityLimits>; now?: () => Date }): Promise<ArtifactRegistrationRecord> {
  const pack = await readAndValidateWebImplementationPack(options.archivePath, options.limits);
  if (pack.manifest.run_id !== options.runId) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Requested run_id does not match implementation-pack.json.");
  let trusted;
  try { trusted = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath); }
  catch (error) { throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Canonical run authority could not be resolved: ${error instanceof Error ? error.message : String(error)}`); }
  const run = trusted.runReceipt;
  if (run.state !== "READY_FOR_CODEX") throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Canonical run state '${run.state}' is not READY_FOR_CODEX.`);
  if (pack.manifest.repository.id !== run.repository_id || pack.manifest.repository.base_branch !== run.base_branch || pack.manifest.repository.base_commit !== run.base_commit) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Web pack repository binding differs from canonical Phase 3 run authority.");
  const head = (await runGit(run.worktree_path, ["rev-parse", "HEAD"], 1024)).trim();
  if (head !== run.base_commit) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Worktree HEAD '${head}' differs from locked base '${run.base_commit}'.`);
  const status = await runGit(run.worktree_path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 1_048_576);
  if (status.length !== 0) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Phase 9 requires a clean Phase 3 worktree before implementation-pack registration.");
  const treeSha = (await runGit(trusted.trustedRepoPath, ["rev-parse", `${run.base_commit}^{tree}`], 1024)).trim();
  if (treeSha !== pack.manifest.repository.tree_sha) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Web pack repository tree SHA differs from Git.");
  const inventoryRaw = await runGit(trusted.trustedRepoPath, ["ls-tree", "-rz", "-l", "--full-tree", run.base_commit], 16 * 1024 * 1024);
  const inventory = validateInventory(pack, parseGitInventory(inventoryRaw));
  validateReadCoverage(pack, inventory);
  const specSetSha256 = await computeAcceptedTaskSpecSetSha256(run.accepted_bundle_path, run.task_id, run.run_id, run.archive_sha256);
  if (specSetSha256 !== pack.manifest.bindings.spec_set_sha256) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Web pack spec_set_sha256 differs from the accepted Task Bundle authority.");
  await validateOperationPreimages(pack, run.worktree_path);
  return await registerWebImplementationPackArtifact({ stateDirectory: options.stateDirectory, sourceArchivePath: options.archivePath, pack, registeredAt: (options.now ? options.now() : new Date()).toISOString() });
}
