import crypto from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnBounded, spawnBoundedBinary } from "../runtime/spawn-bounded.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { buildWebBridgeZip } from "./deterministic-zip.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { computeAcceptedTaskSpecSetSha256 } from "../web-authority/task-spec-authority.js";
import { registerWebImplementationPack } from "../web-authority/authority-service.js";
import type { ArtifactRegistrationRecord } from "../web-authority/contracts.js";
import { assertRepositoryRelativePath } from "../web-authority/pack-reader.js";
import { ReadCoverageStore } from "./read-coverage-store.js";
import { WebBridgeError, contentDigest, parseWebContractEnvelope, parseWebImplementationSubmission, type WebContractEnvelope, type WebImplementationSubmission } from "./contracts.js";

interface InventoryEntry { path: string; mode: string; type: "blob" | "commit"; object_sha: string; size_bytes: number | null; }
function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function environment(): Record<string, string> { const result: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }; for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot"]) if (process.env[key]) result[key] = process.env[key]!; return result; }
async function gitText(cwd: string, args: string[], maximum = 16_777_216): Promise<string> { const result = await spawnBounded({ executable: "git", args: ["-c", "core.hooksPath=/dev/null", ...args], cwd: await realpath(cwd), environment: environment(), timeoutMs: 15_000, stdoutMaxBytes: maximum, stderrMaxBytes: 65_536, shell: false }); if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new WebBridgeError("WEB_PACK_GIT_ATTESTATION_FAILED", "Exact Git snapshot attestation failed."); return result.stdout; }
async function gitBytes(cwd: string, args: string[], maximum = 8_388_609): Promise<Buffer> { const result = await spawnBoundedBinary({ executable: "git", args: ["-c", "core.hooksPath=/dev/null", ...args], cwd: await realpath(cwd), environment: environment(), timeoutMs: 15_000, stdoutMaxBytes: maximum, stderrMaxBytes: 65_536, shell: false }); if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new WebBridgeError("WEB_PACK_GIT_ATTESTATION_FAILED", "Exact Git object read failed."); return result.stdout; }
function parseInventory(raw: string): InventoryEntry[] { return raw.split("\0").filter(Boolean).map((record) => { const tab = record.indexOf("\t"); const match = record.slice(0, tab).match(/^([0-9]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9-]+)$/); if (tab < 1 || !match) throw new WebBridgeError("WEB_PACK_INVENTORY_INVALID", "Git inventory record is invalid."); return { path: record.slice(tab + 1), mode: match[1]!, type: match[2]! as "blob" | "commit", object_sha: match[3]!, size_bytes: match[4] === "-" ? null : Number(match[4]) }; }).sort((a, b) => lexical(a.path, b.path)); }
function glob(pattern: string, value: string): boolean { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*"); return new RegExp(`^${escaped}$`).test(value); }
function allowed(pathValue: string, envelope: WebContractEnvelope): void { assertRepositoryRelativePath(pathValue); if (!envelope.allowed_paths.some((pattern) => glob(pattern, pathValue)) || envelope.forbidden_paths.some((pattern) => glob(pattern, pathValue)) || /(^|\/)(\.env($|\.)|\.git(\/|$)|[^/]*\.(pem|key)$|credentials|secrets?)/i.test(pathValue)) throw new WebBridgeError("WEB_PACK_OPERATION_POLICY_REJECTED", `Operation path '${pathValue}' is outside the sealed contract.`); }

export interface MaterializedWebPack { archive_path: string; archive_sha256: string; registration: ArtifactRegistrationRecord; }

export async function materializeWebImplementationPack(options: { submission: WebImplementationSubmission | unknown; envelope: WebContractEnvelope | unknown; stateDirectory: string; configPath: string; coverageStore?: ReadCoverageStore }): Promise<MaterializedWebPack> {
  const submission = parseWebImplementationSubmission(options.submission);
  const envelope = parseWebContractEnvelope(options.envelope);
  if (submission.contract_only) throw new WebBridgeError("WEB_IMPLEMENTATION_REQUIRED", "Web returned contract_only; the current engine requires a sealed Web implementation pack.");
  if (submission.job_id !== envelope.job_id) throw new WebBridgeError("WEB_PACK_BINDING_MISMATCH", "Implementation submission does not bind the sealed contract job.");
  const trusted = await resolveTrustedRunContext(submission.run_id, options.stateDirectory, options.configPath);
  const run = trusted.runReceipt;
  if (run.repository_id !== envelope.repository.repository_id || run.base_commit !== envelope.repository.base_commit || run.base_branch !== envelope.repository.base_branch) throw new WebBridgeError("WEB_PACK_BINDING_MISMATCH", "Implementation submission differs from canonical run authority.");
  const treeSha = (await gitText(trusted.trustedRepoPath, ["rev-parse", `${run.base_commit}^{tree}`], 128)).trim();
  const inventory = parseInventory(await gitText(trusted.trustedRepoPath, ["ls-tree", "-rz", "-l", "--full-tree", run.base_commit]));
  const inventoryMap = new Map(inventory.map((entry) => [entry.path, entry]));
  const coverage = await (options.coverageStore ?? new ReadCoverageStore(path.join(options.stateDirectory, "bridge", "read-coverage"))).list(envelope.job_id);
  const exactReads = new Map(coverage.filter((receipt) => receipt.base_commit === run.base_commit && receipt.start_byte === 0 && receipt.end_byte_exclusive === receipt.total_bytes).map((receipt) => [receipt.path, receipt]));
  const entries = new Map<string, Buffer>();
  const operations: Array<Record<string, unknown>> = [];
  const preimages: Array<{ path: string; sha256: string | null }> = [];
  for (const [index, operation] of submission.operations.entries()) {
    allowed(operation.path, envelope);
    const inventoryEntry = inventoryMap.get(operation.path);
    if (operation.kind === "create" && inventoryEntry || operation.kind !== "create" && (!inventoryEntry || inventoryEntry.type !== "blob")) throw new WebBridgeError("WEB_PACK_PREIMAGE_INVALID", `Operation kind conflicts with exact base tree at '${operation.path}'.`);
    let preimage: string | null = null;
    if (operation.kind !== "create") {
      const receipt = exactReads.get(operation.path);
      if (!receipt || receipt.blob_sha !== inventoryEntry!.object_sha) throw new WebBridgeError("WEB_PACK_READ_COVERAGE_REQUIRED", `A full local read receipt is required for '${operation.path}'.`);
      const bytes = await gitBytes(trusted.trustedRepoPath, ["show", `${run.base_commit}:${operation.path}`]);
      preimage = sha256(bytes);
      if (receipt.content_sha256 !== preimage) throw new WebBridgeError("WEB_PACK_READ_COVERAGE_DRIFT", `Read receipt content changed for '${operation.path}'.`);
    }
    const opId = `OP-${String(index + 1).padStart(3, "0")}`;
    preimages.push({ path: operation.path, sha256: preimage });
    if (operation.kind === "delete") operations.push({ op_id: opId, kind: "delete_file", path: operation.path, preimage_sha256: preimage });
    else { const payload = Buffer.from(operation.content_base64, "base64"); if (payload.byteLength > 8_388_608 || sha256(payload) !== operation.content_sha256) throw new WebBridgeError("WEB_PACK_PAYLOAD_INVALID", `Payload for '${operation.path}' is invalid.`); const payloadEntry = `payload/${opId}.bin`; entries.set(payloadEntry, payload); operations.push({ op_id: opId, kind: operation.kind === "create" ? "create_file" : "replace_file", path: operation.path, preimage_sha256: preimage, payload_entry: payloadEntry, payload_sha256: operation.content_sha256 }); }
  }
  const specSetSha = await computeAcceptedTaskSpecSetSha256(run.accepted_bundle_path, run.task_id, run.run_id, run.archive_sha256);
  const readCoverage = [...new Map(coverage.filter((receipt) => receipt.base_commit === run.base_commit && inventoryMap.get(receipt.path)?.object_sha === receipt.blob_sha).map((receipt) => [receipt.path, { path: receipt.path, object_sha: receipt.blob_sha, coverage: receipt.start_byte === 0 && receipt.end_byte_exclusive === receipt.total_bytes ? "full" : "partial" }])).values()].sort((a, b) => lexical(a.path, b.path));
  const projectNodes = [...new Map(submission.project_map.filter((node) => inventoryMap.has(node.path)).map((node) => [node.path, { path: node.path, role: node.purpose }])).values()].sort((a, b) => lexical(a.path, b.path));
  const add = (name: string, value: unknown): void => { entries.set(name, canonicalJsonBuffer(value)); };
  add("repository-inventory.json", { schema_version: "2.0", repository_tree_sha: treeSha, entries: inventory });
  add("read-coverage.json", { schema_version: "2.0", repository_tree_sha: treeSha, reads: readCoverage });
  add("project-map.json", { schema_version: "2.0", repository_tree_sha: treeSha, nodes: projectNodes });
  add("source-receipts.json", { schema_version: "2.0", receipts: submission.sources.map((source, index) => ({ source_id: `SRC-${String(index + 1).padStart(3, "0")}`, source_type: source.url.startsWith("https://github.com/") ? "github" : "web", locator: source.url, accessed_at: source.accessed_at, content_sha256: contentDigest(source), authority: "unknown" })) });
  add("preimages.json", { schema_version: "2.0", entries: preimages });
  add("architecture-lock.json", { schema_version: "2.0", spec_set_sha256: specSetSha, decisions: envelope.architecture_decisions.map((decision, index) => ({ id: `ARCH-${String(index + 1).padStart(3, "0")}`, decision })) });
  add("acceptance-lock.json", { schema_version: "2.0", spec_set_sha256: specSetSha, criteria: envelope.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.description })) });
  add("prohibited-changes.json", { schema_version: "2.0", paths: [...new Set([...envelope.forbidden_paths, ".git/**"])].sort(), rules: envelope.non_goals.length ? envelope.non_goals : ["Do not change behavior outside the sealed contract."] });
  add("operations.json", { schema_version: "2.0", operations });
  const binding = (name: string): string => sha256(entries.get(name)!);
  add("implementation-pack.json", { schema_version: "2.0", kind: "wco-web-implementation-pack", pack_id: `PACK-${contentDigest(submission).slice(0, 32).toUpperCase()}`, run_id: run.run_id, task_id: run.task_id, task_bundle_sha256: run.archive_sha256, repository: { id: run.repository_id, base_branch: run.base_branch, base_commit: run.base_commit, tree_sha: treeSha }, bindings: { spec_set_sha256: specSetSha, repository_inventory_sha256: binding("repository-inventory.json"), read_coverage_sha256: binding("read-coverage.json"), project_map_sha256: binding("project-map.json"), source_receipts_sha256: binding("source-receipts.json"), preimages_sha256: binding("preimages.json"), architecture_lock_sha256: binding("architecture-lock.json"), acceptance_lock_sha256: binding("acceptance-lock.json"), prohibited_changes_sha256: binding("prohibited-changes.json"), operations_sha256: binding("operations.json") }, created_at: run.created_at });
  const checksumEntries = [...entries.entries()].sort(([a], [b]) => lexical(a, b)).map(([entryPath, content]) => ({ path: entryPath, sha256: sha256(content), size_bytes: content.byteLength }));
  add("checksums.json", { schema_version: "2.0", algorithm: "sha256", entries: checksumEntries });
  const output = path.join(options.stateDirectory, "bridge", "artifacts", envelope.job_id);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const archive = await buildWebBridgeZip([...entries.entries()].sort(([a], [b]) => lexical(a, b)).map(([entryPath, content]) => ({ path: entryPath, content })), output, "web-implementation-pack.zip", { maximumEntries: 512, maximumArchiveBytes: 33_554_432, maximumUncompressedBytes: 67_108_864 });
  const registration = await registerWebImplementationPack({ runId: run.run_id, stateDirectory: options.stateDirectory, configPath: options.configPath, archivePath: archive.archivePath });
  return { archive_path: archive.archivePath, archive_sha256: archive.sha256, registration };
}
