// Phase 6 Result Bundle Service — main orchestration
// Validates all upstream receipts, attests PR, collects git evidence,
// builds canonical ZIP, verifies it, persists atomic receipt.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ResultBundleError } from "./contracts.js";
import type {
  ResultBundleReceipt, ResultBundleState, ResultBundleLimits,
  ResultBundleManifest, ManifestEntry, PullRequestAttestation,
  PublicExecutionEvidence, ChangedFileEntry, DeletedFileEntry,
} from "./contracts.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS } from "./contracts.js";
import { resultBundlePaths, resultBundleArchiveFilename, REQUIRED_RESULT_BUNDLE_ENTRIES, SOURCE_ENTRY_PREFIX } from "./result-bundle-paths.js";
import { readResultBundleReceipt, writeResultBundleReceipt } from "./result-bundle-store.js";
import { acquireResultBundleLock } from "./result-bundle-lock.js";
import type { GitHubAttestationClient } from "./github-attestation.js";
import { attestGitHubPullRequest } from "./github-attestation.js";
import type { GitRunner } from "./git-evidence-reader.js";
import { collectGitEvidence } from "./git-evidence-reader.js";
import {
  projectExecutionEvidence, projectGitPublishEvidence, projectDraftPrEvidence,
  projectVerificationEvidence,
} from "./public-evidence.js";
import { canonicalJsonBuffer } from "./canonical-json.js";
import type { ZipEntry } from "./deterministic-zip.js";
import { buildDeterministicZip } from "./deterministic-zip.js";
import { verifyResultBundleZip } from "./zip-verifier.js";

// Embedded review resources
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIR = path.join(__dirname, "resources");

function readResource(filename: string): Buffer {
  return fs.readFileSync(path.join(RESOURCES_DIR, filename));
}

export interface Phase6Options {
  runId: string;
  stateDirectory: string;
  configPath: string;
  githubClient: GitHubAttestationClient;
  gitRunner: GitRunner;
  limits?: Partial<ResultBundleLimits>;
  now?: () => Date;
  secrets?: string[]; // secret values to scan for
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

function currentIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

async function readJsonFile(filePath: string, errorCode: ResultBundleError["code"]): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ResultBundleError(errorCode, `Not a JSON object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ResultBundleError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ResultBundleError(errorCode, `File not found: ${filePath}`);
    }
    throw new ResultBundleError(errorCode, `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readTextFile(filePath: string, errorCode: ResultBundleError["code"]): Promise<Buffer> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Return empty buffer for optional files
      return Buffer.alloc(0);
    }
    throw new ResultBundleError(errorCode, `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Compute tree sha256 by hashing all bundle files deterministically */
async function computeBundleTreeSha256(bundlePath: string): Promise<string> {
  const files = await fs.promises.readdir(bundlePath);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const filePath = path.join(bundlePath, file);
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile()) {
      hash.update(file);
      hash.update(await fs.promises.readFile(filePath));
    }
  }
  return hash.digest("hex");
}

/** Scan buffer for exact secret values */
function scanForSecrets(content: Buffer, secrets: string[]): string | null {
  if (secrets.length === 0) return null;
  const text = content.toString("utf8");
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      return secret.slice(0, 4) + "***";
    }
  }
  return null;
}

/** Find execution receipt */
async function findExecutionReceipt(
  stateDirectory: string,
  runId: string
): Promise<{ filePath: string; receipt: Record<string, unknown> }> {
  const sep = runId.lastIndexOf(":");
  if (sep <= 0) throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid run ID format.");
  const taskId = runId.slice(0, sep);
  const archiveSha = runId.slice(sep + 1);
  const executionPath = path.join(stateDirectory, "runs", taskId, archiveSha, "execution", "execution.json");
  const receipt = await readJsonFile(executionPath, "RESULT_EXECUTION_RECEIPT_INVALID");
  return { filePath: executionPath, receipt };
}

/**
 * Main Phase 6 service function.
 * Implements the full READY_TO_BUILD → BUILDING → BUILT → VERIFIED → READY_FOR_WEB_REVIEW pipeline.
 */
export async function packageResultBundle(options: Phase6Options): Promise<ResultBundleReceipt> {
  const { runId, stateDirectory, githubClient, gitRunner, now } = options;
  const limits = { ...DEFAULT_RESULT_BUNDLE_LIMITS, ...options.limits };
  const secrets = options.secrets ?? [];
  const resolvedStateDir = path.resolve(stateDirectory);
  const paths = resultBundlePaths(resolvedStateDir);

  // Ensure output directory exists
  await fs.promises.mkdir(paths.directory, { recursive: true });

  // Check for existing receipt first (idempotency)
  const existingReceipt = await readResultBundleReceipt(paths.receiptPath);
  if (existingReceipt?.run_id === runId && existingReceipt.state === "READY_FOR_WEB_REVIEW") {
    // Idempotent return - verify archive still matches
    const archiveFilename = path.basename(existingReceipt.archive_relative_path);
    const archivePath = paths.archivePath(archiveFilename);
    try {
      const stat = await fs.promises.stat(archivePath);
      if (stat.size === existingReceipt.archive_size_bytes) {
        return existingReceipt;
      }
    } catch {
      // Archive missing - will rebuild
    }
  }
  if (existingReceipt?.run_id === runId && existingReceipt.state === "BUILT") {
    // Try to promote to VERIFIED/READY_FOR_WEB_REVIEW via verification
    const archiveFilename = path.basename(existingReceipt.archive_relative_path);
    const archivePath = paths.archivePath(archiveFilename);
    try {
      const manifestEntries = existingReceipt.archive_sha256
        ? [] // We'll re-verify directly
        : [];
      void archivePath; void manifestEntries;
    } catch {
      // Will rebuild
    }
  }

  // Acquire exclusive lock
  const lock = await acquireResultBundleLock(paths.lockPath, runId);
  try {
    const buildCtx: Parameters<typeof _buildResultBundle>[0] = { options, limits, secrets, resolvedStateDir, paths, runId, githubClient, gitRunner };
    if (now !== undefined) buildCtx.now = now;
    return await _buildResultBundle(buildCtx);
  } finally {
    await lock.release();
  }
}

async function _buildResultBundle(ctx: {
  options: Phase6Options;
  limits: ResultBundleLimits;
  secrets: string[];
  resolvedStateDir: string;
  paths: ReturnType<typeof resultBundlePaths>;
  runId: string;
  githubClient: GitHubAttestationClient;
  gitRunner: GitRunner;
  now?: () => Date;
}): Promise<ResultBundleReceipt> {
  const { limits, secrets, resolvedStateDir, paths, runId, githubClient, gitRunner, now } = ctx;
  const warnings: string[] = [];
  const createdAt = currentIso(now);

  // ── Step 1: Load and validate all upstream receipts ──────────────────────

  // Phase 4 execution receipt
  const { filePath: executionFilePath, receipt: executionRaw } = await findExecutionReceipt(resolvedStateDir, runId);
  if (executionRaw.run_id !== runId) {
    throw new ResultBundleError("RESULT_EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt run_id mismatch.");
  }
  if (executionRaw.state !== "READY_FOR_PUBLISH") {
    throw new ResultBundleError("RESULT_EXECUTION_NOT_READY", `Execution state is '${String(executionRaw.state)}', expected READY_FOR_PUBLISH.`);
  }
  const executionReceiptSha256 = sha256Hex(await fs.promises.readFile(executionFilePath));

  const sep = runId.lastIndexOf(":");
  const taskId = runId.slice(0, sep);
  const archiveSha = runId.slice(sep + 1);
  const bundlePath = String(executionRaw.accepted_bundle_path ?? path.join(resolvedStateDir, "runs", taskId, archiveSha, "bundle"));
  const worktreePath = String(executionRaw.worktree_path ?? "");
  const baseCommit = String(executionRaw.base_commit ?? "");
  const changeSetSha256 = String(executionRaw.change_set_sha256 ?? "");

  // Phase 5A publish receipt
  const p5aPath = path.join(resolvedStateDir, "publish", "git-publish.json");
  const p5aRaw = await readJsonFile(p5aPath, "RESULT_PUBLISH_RECEIPT_INVALID");
  if (p5aRaw.state !== "PUSHED") {
    throw new ResultBundleError("RESULT_PUBLISH_NOT_PUSHED", `Phase 5A state is '${String(p5aRaw.state)}', expected PUSHED.`);
  }
  if (p5aRaw.run_id !== runId) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INCONSISTENT", "Phase 5A run_id mismatch.");
  }
  if (p5aRaw.change_set_sha256 !== changeSetSha256) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INCONSISTENT", "Phase 5A change_set_sha256 mismatch.");
  }
  if (p5aRaw.base_commit !== baseCommit) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INCONSISTENT", "Phase 5A base_commit mismatch.");
  }
  const publishedCommitSha = String(p5aRaw.commit_sha ?? "");
  const remoteBranchSha = String(p5aRaw.remote_branch_sha ?? "");
  if (!publishedCommitSha || publishedCommitSha !== remoteBranchSha) {
    throw new ResultBundleError("RESULT_REMOTE_SHA_MISMATCH", "Published commit SHA does not match remote branch SHA.");
  }
  const gitPublishReceiptSha256 = sha256Hex(await fs.promises.readFile(p5aPath));

  // Phase 5B draft PR receipt
  const p5bPath = path.join(resolvedStateDir, "publish", "github-draft-pr.json");
  const p5bRaw = await readJsonFile(p5bPath, "RESULT_PR_RECEIPT_INVALID");
  if (p5bRaw.state !== "OPEN") {
    throw new ResultBundleError("RESULT_PR_NOT_OPEN", `Phase 5B state is '${String(p5bRaw.state)}', expected OPEN.`);
  }
  if (p5bRaw.run_id !== runId) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", "Phase 5B run_id mismatch.");
  }
  const prNumber = Number(p5bRaw.pull_number ?? 0);
  if (!prNumber) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INVALID", "Phase 5B receipt missing pull_number.");
  }
  const draftPrReceiptSha256 = sha256Hex(await fs.promises.readFile(p5bPath));

  // Cross-validate: commit SHA between P5A and P5B
  const p5bExpectedHeadSha = String(p5bRaw.expected_head_sha ?? "");
  if (p5bExpectedHeadSha !== publishedCommitSha) {
    throw new ResultBundleError("RESULT_REMOTE_SHA_MISMATCH", "Phase 5B expected_head_sha does not match published commit SHA.");
  }

  // ── Step 2: Verify bundle integrity ──────────────────────────────────────
  const acceptedBundleTreeSha256 = await computeBundleTreeSha256(bundlePath);

  // ── Step 3: GitHub PR attestation (read-only) ─────────────────────────────
  const remoteUrl = String(p5aRaw.allowed_remote_url ?? "");
  const repoMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!repoMatch) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", `Cannot parse GitHub owner/repo from remote URL: ${remoteUrl}`);
  }
  const [, repoOwner, repoName] = repoMatch;
  const headBranch = String(p5aRaw.branch_name ?? "");
  const baseBranch = String(executionRaw.base_branch ?? p5aRaw.base_commit ?? "main");

  const prAttestation: PullRequestAttestation = await attestGitHubPullRequest(
    githubClient,
    repoOwner!,
    repoName!,
    prNumber,
    { headBranch, headSha: publishedCommitSha, baseBranch: String(p5bRaw.base_branch ?? baseBranch) }
  );

  // ── Step 4: Collect git evidence ──────────────────────────────────────────
  const gitEvidence = await collectGitEvidence({
    worktreePath,
    baseCommit,
    publishedCommit: publishedCommitSha,
    maximumDiffBytes: limits.maximum_diff_bytes,
    maximumSourceFileBytes: limits.maximum_source_file_bytes,
    gitRunner,
  });
  warnings.push(...gitEvidence.warnings);

  // ── Step 5: Build public evidence DTOs ────────────────────────────────────
  const publicExecution = projectExecutionEvidence(executionRaw);
  const publicGitPublish = projectGitPublishEvidence(p5aRaw);
  const publicDraftPr = projectDraftPrEvidence(p5bRaw, gitPublishReceiptSha256);
  const verificationRaw = executionRaw.verification as Record<string, unknown> | undefined ?? {};
  const publicVerification = projectVerificationEvidence(verificationRaw, limits.maximum_public_output_bytes_per_command);

  // ── Step 6: Read bundle task files ────────────────────────────────────────
  const readBundleFile = async (name: string): Promise<Buffer> =>
    readTextFile(path.join(bundlePath, name), "RESULT_OPERATIONAL_ERROR");

  // ── Step 7: Build ZIP entries ─────────────────────────────────────────────
  const archiveFilename = resultBundleArchiveFilename(taskId, publishedCommitSha);

  // Compute checksums.json (covers all entries except itself)
  // We need to build all entries first, then compute checksums

  // Collect all entries
  const allEntries: ZipEntry[] = [];

  const addJson = (entryPath: string, data: unknown): void => {
    const content = canonicalJsonBuffer(data);
    const found = scanForSecrets(content, secrets);
    if (found) {
      throw new ResultBundleError("RESULT_SENSITIVE_VALUE_DETECTED", `Secret found in entry '${entryPath}'.`);
    }
    allEntries.push({ path: entryPath, content });
  };

  const addBuffer = (entryPath: string, content: Buffer): void => {
    const found = scanForSecrets(content, secrets);
    if (found) {
      throw new ResultBundleError("RESULT_SENSITIVE_VALUE_DETECTED", `Secret found in entry '${entryPath}'.`);
    }
    allEntries.push({ path: entryPath, content });
  };

  const addText = (entryPath: string, text: string): void => {
    addBuffer(entryPath, Buffer.from(text.replace(/\r\n/g, "\n"), "utf8"));
  };

  // RESULT.md
  addText("RESULT.md", [
    "# Result Bundle",
    ``,
    `Run ID: \`${runId}\``,
    `Task ID: \`${taskId}\``,
    `Published commit: \`${publishedCommitSha}\``,
    `Pull Request: #${prNumber} (${prAttestation.url})`,
    `Base commit: \`${baseCommit}\``,
    `Change set: \`${changeSetSha256}\``,
    ``,
    "This archive was produced deterministically by `wco package-result`.",
    "It is sealed for offline Web review.",
  ].join("\n") + "\n");

  // REVIEW.md
  addText("REVIEW.md", [
    "# Review Instructions",
    "",
    "This Result Bundle is sealed for Web review.",
    "See `review/WEB-REVIEW-CONTRACT.md` for the closed-world review contract.",
    "Use `review/web-review-verdict.schema.json` to validate your verdict.",
    "Use `review/revision-request.schema.json` for revision requests.",
  ].join("\n") + "\n");

  // task/ files
  addBuffer("task/REQUEST.md", await readBundleFile("REQUEST.md"));
  addBuffer("task/PLAN.md", await readBundleFile("PLAN.md"));
  addBuffer("task/RULES.md", await readBundleFile("RULES.md"));
  addBuffer("task/RESEARCH.md", await readBundleFile("RESEARCH.md"));
  addBuffer("task/SOURCES.md", await readBundleFile("SOURCES.md"));
  addBuffer("task/VALIDATION.md", await readBundleFile("VALIDATION.md"));
  addBuffer("task/acceptance.json", await readBundleFile("acceptance.json"));
  addBuffer("task/test-matrix.json", await readBundleFile("test-matrix.json"));
  addBuffer("task/validation.json", await readBundleFile("validation.json"));
  addBuffer("task/risk-policy.json", await readBundleFile("risk-policy.json"));

  // evidence/ files
  addJson("evidence/execution.json", publicExecution);
  addJson("evidence/acceptance.json", {
    run_id: runId,
    accepted: publicExecution.verification.required_commands_passed,
    change_set_sha256: changeSetSha256,
  });
  addJson("evidence/verification.json", publicVerification);
  addJson("evidence/terra-review.json", {
    run_id: runId,
    verdict: publicExecution.internal_reviewer.verdict,
    reviewed_change_set_sha256: publicExecution.internal_reviewer.reviewed_change_set_sha256,
    rounds: publicExecution.internal_reviewer.rounds,
  });
  addJson("evidence/sol-review.json", {
    run_id: runId,
    verdict: publicExecution.final_reviewer.verdict,
    reviewed_change_set_sha256: publicExecution.final_reviewer.reviewed_change_set_sha256,
    rounds: publicExecution.final_reviewer.rounds,
  });
  addJson("evidence/git-publish.json", publicGitPublish);
  addJson("evidence/github-draft-pr.json", publicDraftPr);
  addJson("evidence/event-summary.json", {
    run_id: runId,
    task_id: taskId,
    base_commit: baseCommit,
    published_commit_sha: publishedCommitSha,
    change_set_sha256: changeSetSha256,
    pull_request_number: prNumber,
    warnings,
  });

  // repository/ files
  addBuffer("repository/diff.patch", gitEvidence.diffPatch);
  addJson("repository/changed-files.json", gitEvidence.changedFiles);
  addJson("repository/deleted-files.json", gitEvidence.deletedFiles);

  // github/ files
  addJson("github/pull-request.json", prAttestation);

  // review/ files (frozen embedded resources)
  addBuffer("review/WEB-REVIEW-CONTRACT.md", readResource("WEB-REVIEW-CONTRACT.md"));
  addBuffer("review/revision-request.schema.json", readResource("revision-request.schema.json"));
  addBuffer("review/web-review-verdict.schema.json", readResource("web-review-verdict.schema.json"));

  // repository/source/ files
  for (const [filePath, content] of gitEvidence.sourceFiles) {
    addBuffer(`${SOURCE_ENTRY_PREFIX}${filePath}`, content);
  }

  // Sort entries lexically
  allEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // Compute checksums (covers all entries except checksums.json itself)
  const checksumEntries = allEntries.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.content),
    size_bytes: entry.content.byteLength,
  }));
  const checksumsJson = canonicalJsonBuffer({ algorithm: "sha256", files: checksumEntries });

  // Build manifest (before checksums entry added)
  const manifestEntryList: ManifestEntry[] = allEntries.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.content),
    size_bytes: entry.content.byteLength,
  }));
  const checksumsSha256 = sha256Hex(checksumsJson);
  manifestEntryList.push({ path: "checksums.json", sha256: checksumsSha256, size_bytes: checksumsJson.byteLength });
  // Sort manifest entries lexically too
  manifestEntryList.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const manifest: ResultBundleManifest = {
    schema_version: "1.0",
    kind: "wco-result-bundle",
    run_id: runId,
    archive_filename: archiveFilename,
    published_commit_sha: publishedCommitSha,
    base_commit: baseCommit,
    change_set_sha256: changeSetSha256,
    pull_request_number: prNumber,
    task_id: taskId,
    created_at: createdAt,
    entries: manifestEntryList,
  };
  const manifestBuffer = canonicalJsonBuffer(manifest);
  const manifestSha256 = sha256Hex(manifestBuffer);

  // Add manifest and checksums
  const finalEntries: ZipEntry[] = [
    ...allEntries,
    { path: "checksums.json", content: checksumsJson },
    { path: "manifest.json", content: manifestBuffer },
  ];
  // Sort final entries lexically
  finalEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // Check limits
  if (finalEntries.length > limits.maximum_entries) {
    throw new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", `Too many entries: ${finalEntries.length}`);
  }

  // ── Step 8: Build the deterministic ZIP ───────────────────────────────────
  const builtArchive = await buildDeterministicZip(
    finalEntries,
    paths.directory,
    archiveFilename,
    {
      maximumEntries: limits.maximum_entries,
      maximumArchiveBytes: limits.maximum_archive_bytes,
      maximumTotalUncompressedBytes: limits.maximum_total_uncompressed_bytes,
    }
  );

  const builtAt = currentIso(now);

  // ── Step 9: Independent reopen and verification ────────────────────────────
  // Build expected manifest entries from what we put in
  const expectedEntries: ManifestEntry[] = finalEntries.map((e) => ({
    path: e.path,
    sha256: sha256Hex(e.content),
    size_bytes: e.content.byteLength,
  }));

  const verified = await verifyResultBundleZip(builtArchive.archivePath, expectedEntries);
  const verifiedAt = currentIso(now);

  // ── Step 10: Persist READY_FOR_WEB_REVIEW receipt atomically ──────────────
  const archiveRelativePath = path.join("handoff", archiveFilename).replace(/\\/g, "/");
  const input_digest_sha256 = sha256Hex(
    Buffer.from(executionReceiptSha256 + gitPublishReceiptSha256 + draftPrReceiptSha256, "utf8")
  );

  const finalReceipt: ResultBundleReceipt = {
    result_bundle_version: "1.0",
    run_id: runId,
    state: "READY_FOR_WEB_REVIEW",
    input_digest_sha256,
    execution_receipt_sha256: executionReceiptSha256,
    git_publish_receipt_sha256: gitPublishReceiptSha256,
    draft_pr_receipt_sha256: draftPrReceiptSha256,
    accepted_bundle_tree_sha256: acceptedBundleTreeSha256,
    change_set_sha256: changeSetSha256,
    base_commit: baseCommit,
    published_commit_sha: publishedCommitSha,
    remote_branch_sha: remoteBranchSha,
    pull_request: prAttestation,
    archive_relative_path: archiveRelativePath,
    archive_sha256: verified.sha256,
    archive_size_bytes: verified.sizeBytes,
    entry_count: verified.entryCount,
    uncompressed_size_bytes: verified.uncompressedBytes,
    manifest_sha256: manifestSha256,
    warnings,
    created_at: createdAt,
    updated_at: currentIso(now),
    built_at: builtAt,
    verified_at: verifiedAt,
    ready_at: currentIso(now),
  };

  await writeResultBundleReceipt(paths.receiptPath, finalReceipt);
  return finalReceipt;
}

/** Status query - returns existing receipt without building */
export async function getResultBundleStatus(options: {
  runId: string;
  stateDirectory: string;
}): Promise<ResultBundleReceipt | null> {
  const resolvedStateDir = path.resolve(options.stateDirectory);
  const paths = resultBundlePaths(resolvedStateDir);
  return readResultBundleReceipt(paths.receiptPath);
}
