import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { GitRunner } from "../git/git-runner.js";
import type { ResultBundleReceipt, ResultBundleLimits, ResultBundleManifest, ManifestEntry, PullRequestAttestation, ChangedFileEntry, DeletedFileEntry } from "../result-bundle/contracts.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS, ResultBundleError } from "../result-bundle/contracts.js";
import type { ZipEntry } from "../result-bundle/deterministic-zip.js";
import { buildDeterministicZip } from "../result-bundle/deterministic-zip.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { verifyResultBundleZip } from "../result-bundle/zip-verifier.js";
import { writeResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import type { RevisionReceipt } from "./contracts.js";
import type { LoadedRevisionSource } from "./revision-source.js";
import type { RevisionGitHubAttestation } from "./revision-github-attestation.js";
import { assertExistingRevisionPathSafe, type RevisionRoundPaths } from "./revision-paths.js";

const TASK_FILES = [
  "manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md",
  "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json",
] as const;
const MAX_CHANGED_PATHS = 2000;

function sha256(data: Buffer | string): string { return crypto.createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex"); }
function iso(now?: () => Date): string { return (now ? now() : new Date()).toISOString(); }
function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((p) => !p || p === "." || p === "..")) throw new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Unsafe repository path '${value}'.`);
  return normalized;
}
function gitOut(result: Awaited<ReturnType<GitRunner["run"]>>): string {
  if (result.exitCode !== 0) throw new ResultBundleError("RESULT_GIT_INSPECTION_FAILED", result.stderr.trim() || result.stdout.trim() || "Git inspection failed.");
  return result.stdout;
}
function scanSecret(content: Buffer, secrets: string[], label: string): void {
  if (!secrets.length) return;
  const text = content.toString("utf8");
  for (const secret of secrets) if (secret.length >= 8 && text.includes(secret)) throw new ResultBundleError("RESULT_SENSITIVE_VALUE_DETECTED", `Sensitive value detected in '${label}'.`);
}

async function computeAcceptedBundleTree(bundlePath: string): Promise<string> {
  const files = (await fs.readdir(bundlePath)).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const full = path.join(bundlePath, file);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ResultBundleError("RESULT_BUNDLE_INVALID", `Accepted bundle contains unsafe entry '${file}'.`);
    if (!stat.isFile()) continue;
    hash.update(file);
    hash.update(await fs.readFile(full));
  }
  return hash.digest("hex");
}

interface GitEvidence {
  diffPatch: Buffer;
  changedFiles: ChangedFileEntry[];
  deletedFiles: DeletedFileEntry[];
  sourceFiles: Map<string, Buffer>;
  digest: string;
  paths: string[];
}

async function collectGitEvidence(params: { runner: GitRunner; worktree: string; from: string; to: string; limits: ResultBundleLimits }): Promise<GitEvidence> {
  const { runner, worktree, from, to, limits } = params;
  const namesRaw = gitOut(await runner.run(["diff", "--no-renames", "--name-only", "-z", from, to, "--"], worktree));
  const paths = namesRaw.split("\0").filter(Boolean).map(normalizePath).sort((a, b) => a.localeCompare(b));
  if (paths.length > MAX_CHANGED_PATHS || new Set(paths).size !== paths.length) throw new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", "Git evidence path set is oversized or ambiguous.");
  const diffText = gitOut(await runner.run(["diff", "--no-renames", "--no-ext-diff", "--no-color", "--full-index", from, to, "--"], worktree));
  const diffPatch = Buffer.from(diffText, "utf8");
  if (diffPatch.byteLength > limits.maximum_diff_bytes) throw new ResultBundleError("RESULT_SOURCE_FILE_TOO_LARGE", `Git diff exceeds ${limits.maximum_diff_bytes} bytes.`);

  const changedFiles: ChangedFileEntry[] = [];
  const deletedFiles: DeletedFileEntry[] = [];
  const sourceFiles = new Map<string, Buffer>();
  for (const relative of paths) {
    const tree = gitOut(await runner.run(["ls-tree", "-z", to, "--", relative], worktree));
    if (!tree) { deletedFiles.push({ path: relative }); continue; }
    const record = tree.split("\0").find(Boolean)!;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new ResultBundleError("RESULT_GIT_INSPECTION_FAILED", `Malformed ls-tree record for '${relative}'.`);
    const [mode, type, oid] = record.slice(0, tab).split(/\s+/);
    const actual = normalizePath(record.slice(tab + 1));
    if (actual !== relative || type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw new ResultBundleError("RESULT_UNSUPPORTED_CHANGE_TYPE", `Unsupported Git entry for '${relative}'.`);
    const full = path.join(worktree, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Current source path is not a regular file: '${relative}'.`);
    if (stat.size > limits.maximum_source_file_bytes) throw new ResultBundleError("RESULT_SOURCE_FILE_TOO_LARGE", `Source file '${relative}' exceeds ${limits.maximum_source_file_bytes} bytes.`);
    const bytes = await fs.readFile(full);
    const localOid = gitOut(await runner.run(["hash-object", "--no-filters", "--", relative], worktree)).trim();
    if (localOid !== oid) throw new ResultBundleError("RESULT_SOURCE_CONTENT_MISMATCH", `Worktree bytes for '${relative}' do not match published commit '${to}'.`);
    sourceFiles.set(relative, bytes);
    changedFiles.push({ path: relative, mode, sha256: sha256(bytes), size_bytes: bytes.byteLength });
  }
  const digest = sha256(canonicalJsonBuffer({ from, to, changed_files: changedFiles, deleted_files: deletedFiles, diff_sha256: sha256(diffPatch) }));
  return { diffPatch, changedFiles, deletedFiles, sourceFiles, digest, paths };
}

export interface RevisionResultBundleOptions {
  stateDirectory: string;
  paths: RevisionRoundPaths;
  source: LoadedRevisionSource;
  revisionReceipt: RevisionReceipt;
  revisionEvidence: Record<string, unknown>;
  revisionEvidenceSha256: string;
  publishEvidence: Record<string, unknown>;
  publishEvidenceSha256: string;
  prAttestation: RevisionGitHubAttestation;
  acceptedBundlePath: string;
  originalBaseCommit: string;
  worktreePath: string;
  runner: GitRunner;
  limits?: Partial<ResultBundleLimits> | undefined;
  secrets?: string[] | undefined;
  now?: (() => Date) | undefined;
}

export async function packageRevisionResultBundle(options: RevisionResultBundleOptions): Promise<ResultBundleReceipt> {
  const { source, revisionReceipt, prAttestation, paths, runner } = options;
  const limits = { ...DEFAULT_RESULT_BUNDLE_LIMITS, ...options.limits };
  const secrets = options.secrets ?? [];
  const runId = source.request.run_id;
  const [taskId, taskArchiveSha] = runId.split(":");
  if (!taskId || !taskArchiveSha) throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid revision run_id.");
  if (revisionReceipt.state !== "PUSHED" || !revisionReceipt.new_published_commit_sha || !revisionReceipt.remote_branch_sha || revisionReceipt.new_published_commit_sha !== revisionReceipt.remote_branch_sha) throw new ResultBundleError("RESULT_PUBLISH_NOT_PUSHED", "Revision receipt must be PUSHED with identical commit/remote SHA before packaging.");
  if (revisionReceipt.revision_round !== source.request.revision_round || revisionReceipt.revision_request_sha256 !== source.requestSha256) throw new ResultBundleError("RESULT_RECEIPT_INCONSISTENT", "Revision receipt does not bind the sealed request.");
  await assertExistingRevisionPathSafe(options.stateDirectory, paths.resultDirectory, "directory");

  await verifyBundleChecksums(options.acceptedBundlePath).catch((error) => { throw new ResultBundleError("RESULT_BUNDLE_INVALID", `Accepted bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`); });
  const acceptedBundleTreeSha256 = await computeAcceptedBundleTree(options.acceptedBundlePath);
  if (acceptedBundleTreeSha256 !== source.previousResultBundle.receipt.accepted_bundle_tree_sha256) throw new ResultBundleError("RESULT_BUNDLE_MUTATED", "Accepted bundle tree changed since the previous verified Result Bundle.");

  const newHead = revisionReceipt.new_published_commit_sha;
  const cumulative = await collectGitEvidence({ runner, worktree: options.worktreePath, from: options.originalBaseCommit, to: newHead, limits });
  const delta = await collectGitEvidence({ runner, worktree: options.worktreePath, from: source.request.previous_pr_head_sha, to: newHead, limits });
  if (revisionReceipt.revision_paths.length && JSON.stringify([...revisionReceipt.revision_paths].sort()) !== JSON.stringify(delta.paths)) throw new ResultBundleError("RESULT_DIFF_MISMATCH", "Revision receipt path set does not match published previous-head→new-head delta.");

  const allEntries: ZipEntry[] = [];
  const addBuffer = (entryPath: string, content: Buffer): void => { scanSecret(content, secrets, entryPath); allEntries.push({ path: entryPath, content }); };
  const addJson = (entryPath: string, value: unknown): void => addBuffer(entryPath, canonicalJsonBuffer(value));
  const addText = (entryPath: string, value: string): void => addBuffer(entryPath, Buffer.from(value.replace(/\r\n/g, "\n"), "utf8"));

  addText("RESULT.md", `# Revision Result Bundle\n\nRun ID: \`${runId}\`\nRevision round: ${source.request.revision_round}\nPrevious head: \`${source.request.previous_pr_head_sha}\`\nPublished head: \`${newHead}\`\nPull Request: #${source.request.pull_request_number}\n`);
  addText("REVIEW.md", "# Review Instructions\n\nThis is a Phase 8 revision Result Bundle. Review the cumulative `repository/*` state and use `revision/*` to verify the exact previous-head→new-head correction chain. The frozen contract in `review/*` remains authoritative.\n");

  const taskFiles: Array<{ name: string; buffer: Buffer }> = [];
  for (const name of TASK_FILES) {
    const full = path.join(options.acceptedBundlePath, name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limits.maximum_entry_bytes) throw new ResultBundleError("RESULT_BUNDLE_INVALID", `Unsafe frozen task file '${name}'.`);
    const buffer = await fs.readFile(full);
    taskFiles.push({ name, buffer }); addBuffer(`task/${name}`, buffer);
  }
  const taskReadme = Buffer.from(["# Task Specification Overview","",`Task ID: \`${taskId}\``,`Run ID: \`${runId}\``,`Archive SHA-256: \`${taskArchiveSha}\``,"","This directory contains the task specification and spec-lock.","Files copied from the accepted task bundle are preserved verbatim.","The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",""].join("\n"), "utf8");
  taskFiles.push({ name: "README.md", buffer: taskReadme }); addBuffer("task/README.md", taskReadme);
  const authoritativeFiles = [...taskFiles].sort((a,b)=>a.name.localeCompare(b.name)).map((f)=>({ path:`task/${f.name}`, sha256:sha256(f.buffer), size_bytes:f.buffer.byteLength }));
  const specSetSha256 = sha256(canonicalJsonBuffer(authoritativeFiles));
  if (specSetSha256 !== source.request.spec_set_sha256 || specSetSha256 !== source.previousResultBundle.receipt.spec_set_sha256) throw new ResultBundleError("RESULT_BUNDLE_MUTATED", "Frozen spec set changed while creating the revision Result Bundle.");
  addJson("task/spec-lock.json", { lock_version:"1.0", task_id:taskId, task_archive_sha256:taskArchiveSha, accepted_bundle_tree_sha256:acceptedBundleTreeSha256, authoritative_files:authoritativeFiles, spec_set_sha256:specSetSha256 });

  const frozen = source.previousResultBundle.reviewEntries;
  for (const entry of ["review/WEB-REVIEW-CONTRACT.md","review/web-review-policy.json","review/web-review-verdict.schema.json","review/revision-request.schema.json"] as const) {
    const bytes = frozen.get(entry); if (!bytes) throw new ResultBundleError("RESULT_BUNDLE_INVALID", `Previous Result Bundle omitted frozen entry '${entry}'.`); addBuffer(entry, bytes);
  }
  const reviewContractSha = sha256(frozen.get("review/WEB-REVIEW-CONTRACT.md")!);
  const reviewPolicySha = sha256(frozen.get("review/web-review-policy.json")!);
  const verdictSchemaSha = sha256(frozen.get("review/web-review-verdict.schema.json")!);
  const revisionSchemaSha = sha256(frozen.get("review/revision-request.schema.json")!);
  if (reviewContractSha !== source.previousResultBundle.receipt.review_contract_sha256 || reviewPolicySha !== source.previousResultBundle.receipt.review_policy_sha256 || verdictSchemaSha !== source.previousResultBundle.receipt.verdict_schema_sha256 || revisionSchemaSha !== source.previousResultBundle.receipt.revision_request_schema_sha256) throw new ResultBundleError("RESULT_BUNDLE_MUTATED", "Frozen Web review resources drifted between Result Bundles.");

  addJson("evidence/execution.json", options.revisionEvidence);
  addJson("evidence/acceptance.json", { run_id:runId, accepted:true, change_set_sha256:cumulative.digest, revision_round:source.request.revision_round });
  addJson("evidence/verification.json", revisionReceipt.verification);
  addJson("evidence/terra-review.json", revisionReceipt.terra_review);
  addJson("evidence/sol-review.json", revisionReceipt.sol_review);
  addJson("evidence/git-publish.json", options.publishEvidence);
  addJson("evidence/github-draft-pr.json", prAttestation);
  addJson("evidence/event-summary.json", { run_id:runId, revision_round:source.request.revision_round, base_commit:options.originalBaseCommit, previous_head_sha:source.request.previous_pr_head_sha, published_commit_sha:newHead, cumulative_change_set_sha256:cumulative.digest, revision_change_set_sha256:delta.digest, pull_request_number:source.request.pull_request_number });

  addBuffer("repository/diff.patch", cumulative.diffPatch); addJson("repository/changed-files.json", cumulative.changedFiles); addJson("repository/deleted-files.json", cumulative.deletedFiles);
  for (const [relative, bytes] of cumulative.sourceFiles) addBuffer(`repository/source/${relative}`, bytes);
  addBuffer("revision/diff.patch", delta.diffPatch); addJson("revision/changed-files.json", delta.changedFiles); addJson("revision/deleted-files.json", delta.deletedFiles);
  addBuffer("revision/revision-request.json", source.requestBuffer); addBuffer("revision/previous-web-verdict.json", source.previousVerdictBuffer); addJson("revision/evidence.json", options.revisionEvidence); addJson("revision/publish.json", options.publishEvidence);
  for (const [relative, bytes] of delta.sourceFiles) addBuffer(`revision/source/${relative}`, bytes);
  addJson("github/pull-request.json", prAttestation);

  allEntries.sort((a,b)=>a.path.localeCompare(b.path));
  const checksums = canonicalJsonBuffer({ algorithm:"sha256", files:allEntries.map((entry)=>({ path:entry.path, sha256:sha256(entry.content), size_bytes:entry.content.byteLength })) });
  const manifestEntries: ManifestEntry[] = allEntries.map((entry)=>({ path:entry.path, sha256:sha256(entry.content), size_bytes:entry.content.byteLength }));
  manifestEntries.push({ path:"checksums.json", sha256:sha256(checksums), size_bytes:checksums.byteLength }); manifestEntries.sort((a,b)=>a.path.localeCompare(b.path));
  const reviewedEntrySetSha256 = sha256(canonicalJsonBuffer(manifestEntries));
  const archiveFilename = `wco-result-${taskId}-${newHead.slice(0,12)}.zip`;
  const createdAt = iso(options.now);
  const manifest: ResultBundleManifest = { schema_version:"1.1", kind:"wco-result-bundle", run_id:runId, archive_filename:archiveFilename, published_commit_sha:newHead, base_commit:options.originalBaseCommit, change_set_sha256:cumulative.digest, pull_request_number:source.request.pull_request_number, task_id:taskId, created_at:createdAt, spec_set_sha256:specSetSha256, review_contract_sha256:reviewContractSha, review_policy_sha256:reviewPolicySha, verdict_schema_sha256:verdictSchemaSha, revision_request_schema_sha256:revisionSchemaSha, reviewed_entry_set_sha256:reviewedEntrySetSha256, entries:manifestEntries };
  const manifestBuffer = canonicalJsonBuffer(manifest); const manifestSha = sha256(manifestBuffer);
  const finalEntries = [...allEntries,{path:"checksums.json",content:checksums},{path:"manifest.json",content:manifestBuffer}].sort((a,b)=>a.path.localeCompare(b.path));
  if (finalEntries.length > limits.maximum_entries) throw new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", `Revision Result Bundle has ${finalEntries.length} entries; limit is ${limits.maximum_entries}.`);
  for (const entry of finalEntries) if (entry.content.byteLength > limits.maximum_entry_bytes) throw new ResultBundleError("RESULT_SOURCE_FILE_TOO_LARGE", `Result entry '${entry.path}' exceeds maximum_entry_bytes.`);

  const previousReceiptSha = source.previousResultBundle.phase6ReceiptSha256;
  const inputDigest = sha256(options.revisionEvidenceSha256 + options.publishEvidenceSha256 + source.requestSha256 + previousReceiptSha + source.request.previous_verdict_sha256);
  const prReceipt: PullRequestAttestation = { number:prAttestation.pullRequestNumber, url:prAttestation.htmlUrl, state:"open", draft:true, head_branch:prAttestation.headBranch, head_sha:prAttestation.headSha, base_branch:prAttestation.baseBranch, title_sha256:source.previousResultBundle.receipt.pull_request.title_sha256 };
  const receipt: ResultBundleReceipt = {
    result_bundle_version:"1.2", input_kind:"revision", revision_round:source.request.revision_round, run_id:runId, state:"READY_TO_BUILD",
    input_digest_sha256:inputDigest,
    execution_receipt_sha256:source.previousResultBundle.receipt.execution_receipt_sha256,
    git_publish_receipt_sha256:source.previousResultBundle.receipt.git_publish_receipt_sha256,
    draft_pr_receipt_sha256:source.previousResultBundle.receipt.draft_pr_receipt_sha256,
    revision_evidence_sha256:options.revisionEvidenceSha256,
    revision_request_sha256:source.requestSha256,
    previous_result_bundle_sha256:source.request.previous_result_bundle_sha256,
    previous_result_receipt_sha256:previousReceiptSha,
    previous_verdict_sha256:source.request.previous_verdict_sha256,
    previous_published_commit_sha:source.request.previous_published_commit_sha,
    previous_pr_head_sha:source.request.previous_pr_head_sha,
    accepted_bundle_tree_sha256:acceptedBundleTreeSha256, change_set_sha256:cumulative.digest, base_commit:options.originalBaseCommit, published_commit_sha:newHead, remote_branch_sha:newHead, pull_request:prReceipt,
    archive_relative_path:null, archive_sha256:null, archive_size_bytes:null, entry_count:null, uncompressed_size_bytes:null, manifest_sha256:manifestSha, warnings:[], created_at:createdAt, updated_at:createdAt, built_at:null, verified_at:null, ready_at:null,
    spec_set_sha256:specSetSha256, review_contract_sha256:reviewContractSha, review_policy_sha256:reviewPolicySha, verdict_schema_sha256:verdictSchemaSha, revision_request_schema_sha256:revisionSchemaSha, reviewed_entry_set_sha256:reviewedEntrySetSha256,
  };
  await writeResultBundleReceipt(paths.resultReceiptPath, receipt);
  receipt.state="BUILDING"; receipt.updated_at=iso(options.now); await writeResultBundleReceipt(paths.resultReceiptPath, receipt);
  const built = await buildDeterministicZip(finalEntries, paths.resultDirectory, archiveFilename, { maximumEntries:limits.maximum_entries, maximumArchiveBytes:limits.maximum_archive_bytes, maximumTotalUncompressedBytes:limits.maximum_total_uncompressed_bytes });
  receipt.state="BUILT"; receipt.archive_relative_path=path.relative(path.resolve(options.stateDirectory),built.archivePath).replace(/\\/g,"/"); receipt.archive_sha256=built.sha256; receipt.archive_size_bytes=built.sizeBytes; receipt.entry_count=built.entries.length; receipt.uncompressed_size_bytes=built.uncompressedBytes; receipt.built_at=iso(options.now); receipt.updated_at=iso(options.now); await writeResultBundleReceipt(paths.resultReceiptPath, receipt);
  const verified = await verifyResultBundleZip(built.archivePath);
  if (verified.sha256 !== built.sha256 || verified.reviewedEntrySetSha256 !== reviewedEntrySetSha256) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Independent verification did not reproduce the revision Result Bundle hashes.");
  receipt.state="VERIFIED"; receipt.verified_at=iso(options.now); receipt.updated_at=iso(options.now); await writeResultBundleReceipt(paths.resultReceiptPath, receipt);
  receipt.state="READY_FOR_WEB_REVIEW"; receipt.ready_at=iso(options.now); receipt.updated_at=iso(options.now); await writeResultBundleReceipt(paths.resultReceiptPath, receipt);
  return receipt;
}
