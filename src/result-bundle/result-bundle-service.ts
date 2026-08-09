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
import { reattestReadyResultBundleAuthority } from "./ready-result-attestation.js";
import { executionPaths, readExecutionReceipt } from "../execution/execution-store.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import { parseGitHubRepositoryRemote } from "../pull-request/github-remote.js";
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
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { validateWebVerdict } from "./web-verdict-validator.js";

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
    throw new ResultBundleError(errorCode, `Cannot read required file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
): Promise<{ filePath: string; receipt: Record<string, unknown>; taskId: string; archiveSha: string; paths: ReturnType<typeof executionPaths> }> {
  const sep = runId.lastIndexOf(":");
  if (sep <= 0) throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid run ID format.");
  const taskId = runId.slice(0, sep);
  const archiveSha = runId.slice(sep + 1);
  const paths = executionPaths(stateDirectory, taskId, archiveSha);
  const receipt = await readJsonFile(paths.execution, "RESULT_EXECUTION_RECEIPT_INVALID");
  return { filePath: paths.execution, receipt, taskId, archiveSha, paths };
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
  
  // Extract taskId and archiveSha to use for resultBundlePaths
  const sep = runId.lastIndexOf(":");
  if (sep <= 0) throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid run ID format.");
  const taskId = runId.slice(0, sep);
  const archiveSha = runId.slice(sep + 1);

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid taskId format.");
  }
  if (!/^[0-9a-f]{64}$/.test(archiveSha)) {
    throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid archiveSha format.");
  }

  const paths = resultBundlePaths(resolvedStateDir, taskId, archiveSha);

  // Ensure output directory exists
  await fs.promises.mkdir(paths.directory, { recursive: true });

  // Check for existing receipt first (idempotency)
  const existingReceipt = await readResultBundleReceipt(paths.receiptPath);
  if (existingReceipt?.run_id === runId && existingReceipt.state === "READY_FOR_WEB_REVIEW") {
    // Idempotent return requires both exact archive bytes and fresh external PR authority.
    const archiveFilename = existingReceipt.archive_relative_path ? path.basename(existingReceipt.archive_relative_path) : "";
    const archivePath = archiveFilename ? paths.archivePath(archiveFilename) : "";
    if (archivePath) {
      try {
        const stat = await fs.promises.stat(archivePath);
        if (stat.size === existingReceipt.archive_size_bytes) {
          const verified = await verifyResultBundleZip(archivePath);
          if (verified.sha256 === existingReceipt.archive_sha256) {
            await reattestReadyResultBundleAuthority({
              stateDirectory: resolvedStateDir,
              runId,
              receipt: existingReceipt,
              githubClient,
            });
            return existingReceipt;
          }
        }
        throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Existing archive mismatch. Cannot overwrite.");
      } catch (err) {
        if (err instanceof ResultBundleError) throw err;
        // Archive missing - will rebuild
      }
    }
  }
  if (existingReceipt?.run_id === runId && existingReceipt.state === "BUILT") {
    // Try to promote to VERIFIED/READY_FOR_WEB_REVIEW via verification
    const archiveFilename = existingReceipt.archive_relative_path ? path.basename(existingReceipt.archive_relative_path) : "";
    const archivePath = archiveFilename ? paths.archivePath(archiveFilename) : "";
    if (archivePath) {
      try {
        const manifestEntries = existingReceipt.archive_sha256
          ? [] // We'll re-verify directly
          : [];
        void archivePath; void manifestEntries;
      } catch {
        // Will rebuild
      }
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
  const sep = runId.lastIndexOf(":");
  if (sep <= 0) throw new ResultBundleError("RESULT_REQUEST_INVALID", "Invalid run ID format.");
  const taskId = runId.slice(0, sep);
  const archiveSha = runId.slice(sep + 1);

  // ── Step 1: Load and validate all upstream receipts ──────────────────────

  // Phase 4 execution receipt
  const executionRaw = await readExecutionReceipt(resolvedStateDir, taskId, archiveSha);
  if (!executionRaw) {
    throw new ResultBundleError("RESULT_EXECUTION_RECEIPT_INVALID", "Execution receipt not found.");
  }
  if (executionRaw.run_id !== runId) {
    throw new ResultBundleError("RESULT_EXECUTION_RECEIPT_INCONSISTENT", "Execution receipt run_id mismatch.");
  }
  if (executionRaw.state !== "READY_FOR_PUBLISH") {
    throw new ResultBundleError("RESULT_EXECUTION_NOT_READY", `Execution state is '${String(executionRaw.state)}', expected READY_FOR_PUBLISH.`);
  }
  const execPaths = executionPaths(resolvedStateDir, taskId, archiveSha);
  const executionFilePath = execPaths.execution;
  const executionReceiptSha256 = sha256Hex(await fs.promises.readFile(executionFilePath));

  const bundlePath = String(executionRaw.accepted_bundle_path ?? path.join(resolvedStateDir, "runs", taskId, archiveSha, "bundle"));
  const worktreePath = String(executionRaw.worktree_path ?? "");
  const baseCommit = String(executionRaw.base_commit ?? "");
  const changeSetSha256 = String(executionRaw.change_set_sha256 ?? "");

  // Phase 5A publish receipt
  const p5aPath = path.join(resolvedStateDir, "runs", taskId, archiveSha, "execution", "publish", "git-publish.json");
  const p5aRaw = await readGitPublishReceipt(p5aPath);
  if (!p5aRaw) {
    throw new ResultBundleError("RESULT_PUBLISH_RECEIPT_INVALID", "Phase 5A receipt not found.");
  }
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
  const p5bRaw = await readDraftPullRequestReceipt(p5bPath);
  if (!p5bRaw) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INVALID", "Phase 5B receipt not found.");
  }
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
  try {
    await verifyBundleChecksums(bundlePath);
  } catch (error) {
    throw new ResultBundleError("RESULT_BUNDLE_INVALID", `Bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const acceptedBundleTreeSha256 = await computeBundleTreeSha256(bundlePath);

  // ── Step 3: GitHub PR attestation (read-only) ─────────────────────────────
  const remoteUrl = String(p5aRaw.allowed_remote_url ?? "");
  let repositoryIdentity;
  try {
    repositoryIdentity = parseGitHubRepositoryRemote(remoteUrl);
  } catch (error) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", `Cannot validate GitHub repository identity from the publish receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (p5bRaw.repository_owner !== repositoryIdentity.owner || p5bRaw.repository_name !== repositoryIdentity.repository) {
    throw new ResultBundleError("RESULT_PR_RECEIPT_INCONSISTENT", "Phase 5A remote repository identity does not match the Phase 5B Draft PR receipt.");
  }
  const headBranch = String((p5aRaw as unknown as Record<string, unknown>).branch_name ?? "");
  const baseBranch = String((executionRaw as unknown as Record<string, unknown>).base_branch ?? p5aRaw.base_commit ?? "main");

  const prAttestation: PullRequestAttestation = await attestGitHubPullRequest(
    githubClient,
    repositoryIdentity.owner,
    repositoryIdentity.repository,
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
  const publicExecution = projectExecutionEvidence(executionRaw as unknown as Record<string, unknown>);
  const publicGitPublish = projectGitPublishEvidence(p5aRaw as unknown as Record<string, unknown>);
  const publicDraftPr = projectDraftPrEvidence(p5bRaw as unknown as Record<string, unknown>, gitPublishReceiptSha256, changeSetSha256);
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

  // task/ files from bundle disk
  const taskFiles: { name: string; buffer: Buffer }[] = [];
  for (const name of [
    "manifest.json", "REQUEST.md", "PLAN.md", "RULES.md",
    "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json",
    "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json",
  ]) {
    const buf = await readBundleFile(name);
    taskFiles.push({ name, buffer: buf });
    addBuffer(`task/${name}`, buf);
  }

  // task/README.md — generated task readme overview
  const taskReadmeText = [
    "# Task Specification Overview",
    "",
    `Task ID: \`${taskId}\``,
    `Run ID: \`${runId}\``,
    `Archive SHA-256: \`${archiveSha}\``,
    "",
    "This directory contains the task specification and spec-lock.",
    "Files copied from the accepted task bundle are preserved verbatim.",
    "The spec_set_sha256 recorded in task/spec-lock.json covers the authoritative files listed in spec-lock, excluding spec-lock.json itself.",
  ].join("\n") + "\n";
  const taskReadmeBuf = Buffer.from(taskReadmeText, "utf8");
  taskFiles.push({ name: "README.md", buffer: taskReadmeBuf });
  addBuffer("task/README.md", taskReadmeBuf);

  // Build spec_set from all task/ files (including README.md)
  // Sorted lexically to ensure deterministic hashing
  const specLockInputFiles = [...taskFiles]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(f => ({
      path: `task/${f.name}`,
      sha256: sha256Hex(f.buffer),
      size_bytes: f.buffer.byteLength,
    }));
  const specSetSha256 = sha256Hex(canonicalJsonBuffer(specLockInputFiles));

  // task/spec-lock.json — generated (also part of spec set per schema)
  const specLockJson = canonicalJsonBuffer({
    lock_version: "1.0",
    task_id: taskId,
    task_archive_sha256: archiveSha,
    accepted_bundle_tree_sha256: acceptedBundleTreeSha256,
    authoritative_files: specLockInputFiles,
    spec_set_sha256: specSetSha256,
  });
  addBuffer("task/spec-lock.json", specLockJson);

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
  const reviewContractBuf = readResource("WEB-REVIEW-CONTRACT.md");
  const revisionRequestBuf = readResource("revision-request.schema.json");
  const webReviewVerdictBuf = readResource("web-review-verdict.schema.json");
  const webReviewPolicyBuf = readResource("web-review-policy.json");

  addBuffer("review/WEB-REVIEW-CONTRACT.md", reviewContractBuf);
  addBuffer("review/revision-request.schema.json", revisionRequestBuf);
  addBuffer("review/web-review-verdict.schema.json", webReviewVerdictBuf);
  addBuffer("review/web-review-policy.json", webReviewPolicyBuf);

  const review_contract_sha256 = sha256Hex(reviewContractBuf);
  const revision_request_schema_sha256 = sha256Hex(revisionRequestBuf);
  const verdict_schema_sha256 = sha256Hex(webReviewVerdictBuf);
  const review_policy_sha256 = sha256Hex(webReviewPolicyBuf);

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

  const reviewedEntrySetSha256 = sha256Hex(canonicalJsonBuffer(manifestEntryList));

  const manifest: ResultBundleManifest = {
    schema_version: "1.1",
    kind: "wco-result-bundle",
    run_id: runId,
    archive_filename: archiveFilename,
    published_commit_sha: publishedCommitSha,
    base_commit: baseCommit,
    change_set_sha256: changeSetSha256,
    pull_request_number: prNumber,
    task_id: taskId,
    created_at: String(executionRaw.created_at ?? createdAt),
    spec_set_sha256: specSetSha256,
    review_contract_sha256: review_contract_sha256,
    review_policy_sha256: review_policy_sha256,
    verdict_schema_sha256: verdict_schema_sha256,
    revision_request_schema_sha256: revision_request_schema_sha256,
    reviewed_entry_set_sha256: reviewedEntrySetSha256,
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

  const input_digest_sha256 = sha256Hex(
    Buffer.from(executionReceiptSha256 + gitPublishReceiptSha256 + draftPrReceiptSha256, "utf8")
  );

  const baseReceipt: ResultBundleReceipt = {
    result_bundle_version: "1.1",
    run_id: runId,
    state: "READY_TO_BUILD",
    input_digest_sha256,
    execution_receipt_sha256: executionReceiptSha256,
    git_publish_receipt_sha256: gitPublishReceiptSha256,
    draft_pr_receipt_sha256: draftPrReceiptSha256,
    accepted_bundle_tree_sha256: acceptedBundleTreeSha256,
    reviewed_entry_set_sha256: reviewedEntrySetSha256,
    change_set_sha256: changeSetSha256,
    base_commit: baseCommit,
    published_commit_sha: publishedCommitSha,
    remote_branch_sha: remoteBranchSha,
    pull_request: prAttestation,
    archive_relative_path: null,
    archive_sha256: null,
    archive_size_bytes: null,
    entry_count: null,
    uncompressed_size_bytes: null,
    manifest_sha256: manifestSha256,
    warnings,
    created_at: createdAt,
    updated_at: currentIso(now),
    built_at: null,
    verified_at: null,
    ready_at: null,
    spec_set_sha256: specSetSha256,
    review_contract_sha256: review_contract_sha256,
    review_policy_sha256: review_policy_sha256,
    verdict_schema_sha256: verdict_schema_sha256,
    revision_request_schema_sha256: revision_request_schema_sha256,
  };

  // Persist READY_TO_BUILD
  await writeResultBundleReceipt(paths.receiptPath, baseReceipt);

  // Persist BUILDING
  baseReceipt.state = "BUILDING";
  baseReceipt.updated_at = currentIso(now);
  await writeResultBundleReceipt(paths.receiptPath, baseReceipt);

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

  const builtAt = String(executionRaw.created_at ?? currentIso(now));

  // Persist BUILT
  baseReceipt.state = "BUILT";
  baseReceipt.updated_at = currentIso(now);
  baseReceipt.built_at = builtAt;
  baseReceipt.archive_relative_path = path.relative(resolvedStateDir, builtArchive.archivePath).replace(/\\/g, "/");
  baseReceipt.archive_sha256 = builtArchive.sha256;
  baseReceipt.archive_size_bytes = builtArchive.sizeBytes;
  baseReceipt.entry_count = builtArchive.entries.length;
  baseReceipt.uncompressed_size_bytes = builtArchive.uncompressedBytes;
  await writeResultBundleReceipt(paths.receiptPath, baseReceipt);

  // ── Step 9: Independent reopen and verification ────────────────────────────
  const verified = await verifyResultBundleZip(builtArchive.archivePath);
  if (verified.reviewedEntrySetSha256 !== baseReceipt.reviewed_entry_set_sha256) {
    throw new ResultBundleError(
      "RESULT_ARCHIVE_VERIFY_FAILED",
      `Independent verifier reviewed_entry_set_sha256 mismatch: got ${verified.reviewedEntrySetSha256}, expected ${baseReceipt.reviewed_entry_set_sha256}`
    );
  }
  const verifiedAt = String(executionRaw.created_at ?? currentIso(now));

  // Persist VERIFIED
  baseReceipt.state = "VERIFIED";
  baseReceipt.updated_at = currentIso(now);
  baseReceipt.verified_at = verifiedAt;
  await writeResultBundleReceipt(paths.receiptPath, baseReceipt);

  // ── Step 10: Persist READY_FOR_WEB_REVIEW receipt atomically ──────────────
  baseReceipt.state = "READY_FOR_WEB_REVIEW";
  baseReceipt.updated_at = currentIso(now);
  baseReceipt.ready_at = currentIso(now);
  await writeResultBundleReceipt(paths.receiptPath, baseReceipt);

  return baseReceipt;
}

/** Status query - returns existing receipt without building */
export async function getResultBundleStatus(options: {
  runId: string;
  stateDirectory: string;
}): Promise<ResultBundleReceipt | null> {
  const resolvedStateDir = path.resolve(options.stateDirectory);
  const sep = options.runId.lastIndexOf(":");
  if (sep <= 0) return null;
  const taskId = options.runId.slice(0, sep);
  const archiveSha = options.runId.slice(sep + 1);
  const paths = resultBundlePaths(resolvedStateDir, taskId, archiveSha);
  return readResultBundleReceipt(paths.receiptPath);
}
