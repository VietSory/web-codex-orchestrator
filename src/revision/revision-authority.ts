import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ARCHIVE_LIMITS } from "../intake/constants.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { readStableFile, StableFileError } from "../shared/stable-file.js";
import { RevisionError, type RevisionReceipt, type RevisionResumeState, type RevisionState } from "./contracts.js";

function lexicalCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function computeAcceptedBundleTree(bundlePath: string): Promise<string> {
  const resolved = path.resolve(bundlePath);
  const rootStat = await fs.lstat(resolved).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle cannot be inspected: ${error instanceof Error ? error.message : String(error)}`); });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted bundle must remain a real directory.");
  const canonical = await fs.realpath(resolved).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle canonical path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`); });
  if (canonical !== resolved) throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted bundle must remain one canonical real directory.");

  const files = (await fs.readdir(resolved)).sort(lexicalCompare);
  if (files.length > DEFAULT_ARCHIVE_LIMITS.maximumEntries) {
    throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle exceeds ${DEFAULT_ARCHIVE_LIMITS.maximumEntries} top-level entries.`);
  }
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const full = path.join(resolved, file);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle contains an unsafe entry '${file}'.`);
    if (!stat.isFile()) continue;
    try {
      const bytes = (await readStableFile(full, DEFAULT_ARCHIVE_LIMITS.maximumEntryUncompressedBytes)).bytes;
      hash.update(file);
      hash.update(bytes);
    } catch (error) {
      const message = error instanceof StableFileError ? error.message : error instanceof Error ? error.message : String(error);
      throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle file '${file}' cannot be stably snapshotted within trusted limits: ${message}`);
    }
  }

  const [afterStat, afterNames, afterCanonical] = await Promise.all([
    fs.lstat(resolved),
    fs.readdir(resolved).then((names) => names.sort(lexicalCompare)),
    fs.realpath(resolved),
  ]);
  if (
    afterStat.isSymbolicLink() || !afterStat.isDirectory() ||
    rootStat.dev !== afterStat.dev || rootStat.ino !== afterStat.ino ||
    afterCanonical !== resolved || !sameNames(files, afterNames)
  ) {
    throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted bundle root or top-level entry set changed during revision authority snapshot.");
  }
  return hash.digest("hex");
}

/**
 * Re-attest the accepted Task Bundle against the exact tree already sealed in
 * the previous verified Result Bundle. Updating checksums after tampering does
 * not create new authority.
 */
export async function attestAcceptedBundleAuthority(bundlePath: string, expectedTreeSha256: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(expectedTreeSha256)) throw new RevisionError("REVISION_HISTORY_INVALID", "Previous Result Bundle has an invalid accepted bundle tree binding.");
  const actual = await computeAcceptedBundleTree(bundlePath);
  if (actual !== expectedTreeSha256) throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted Task Bundle no longer matches the tree sealed by the previous verified Result Bundle.");
  await verifyBundleChecksums(bundlePath, DEFAULT_ARCHIVE_LIMITS).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`); });
  return actual;
}

export interface RevisionReceiptAuthority {
  runId: string;
  revisionRound: number;
  revisionRequestSha256: string;
  specSetSha256: string;
  previousResultBundleSha256: string;
  previousResultReceiptSha256: string;
  previousVerdictSha256: string;
  previousPublishedCommitSha: string;
  previousPrHeadSha: string;
  pullRequestNumber: number;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  implementer: { model: string; reasoningEffort: string };
  terra: { model: string; reasoningEffort: string };
  sol: { model: string; reasoningEffort: string };
}

const AMBIGUOUS_MODEL_STATES = new Set<RevisionState>(["IMPLEMENTING", "VERIFYING", "TERRA_REVIEWING", "SOL_REVIEWING"]);
const AMBIGUOUS_MODEL_RESUME_STATES = new Set<RevisionResumeState>(["IMPLEMENTING", "VERIFYING", "TERRA_REVIEWING", "SOL_REVIEWING"]);

function assertNoAmbiguousModelReplay(receipt: RevisionReceipt): void {
  // This authority check runs only when an existing receipt is being adopted by
  // a new reviseRun invocation. These checkpoints span provider-backed work (or
  // a verifier/correction boundary), so the previous process may have started a
  // model call whose outcome was never sealed. Replaying it would violate the
  // pre-call reservation guarantee. Fail closed instead of guessing.
  if (AMBIGUOUS_MODEL_STATES.has(receipt.state)) {
    throw new RevisionError("REVISION_AMBIGUOUS_RECOVERY", `Revision checkpoint '${receipt.state}' may contain an unsealed provider-backed turn; automatic replay is forbidden.`);
  }
  if (receipt.state === "RETRYABLE" && receipt.resume_state && AMBIGUOUS_MODEL_RESUME_STATES.has(receipt.resume_state)) {
    throw new RevisionError("REVISION_AMBIGUOUS_RECOVERY", `Revision retry checkpoint '${receipt.resume_state}' may contain an unsealed provider-backed turn; automatic replay is forbidden.`);
  }
}

/** A mutable checkpoint may record progress; it may never redefine authority. */
export function assertRevisionReceiptAuthority(receipt: RevisionReceipt, expected: RevisionReceiptAuthority): void {
  assertNoAmbiguousModelReplay(receipt);
  const mismatches: string[] = [];
  const same = (field: string, actual: unknown, wanted: unknown): void => { if (actual !== wanted) mismatches.push(field); };
  same("run_id", receipt.run_id, expected.runId);
  same("revision_round", receipt.revision_round, expected.revisionRound);
  same("revision_request_sha256", receipt.revision_request_sha256, expected.revisionRequestSha256);
  same("spec_set_sha256", receipt.spec_set_sha256, expected.specSetSha256);
  same("previous_result_bundle_sha256", receipt.previous_result_bundle_sha256, expected.previousResultBundleSha256);
  same("previous_result_receipt_sha256", receipt.previous_result_receipt_sha256, expected.previousResultReceiptSha256);
  same("previous_verdict_sha256", receipt.previous_verdict_sha256, expected.previousVerdictSha256);
  same("previous_published_commit_sha", receipt.previous_published_commit_sha, expected.previousPublishedCommitSha);
  same("previous_pr_head_sha", receipt.previous_pr_head_sha, expected.previousPrHeadSha);
  same("pull_request_number", receipt.pull_request_number, expected.pullRequestNumber);
  same("branch_name", receipt.branch_name, expected.branchName);
  same("base_branch", receipt.base_branch, expected.baseBranch);
  same("worktree_path", path.resolve(receipt.worktree_path), path.resolve(expected.worktreePath));
  same("implementer.model", receipt.implementer.model, expected.implementer.model);
  same("implementer.reasoning_effort", receipt.implementer.reasoning_effort, expected.implementer.reasoningEffort);
  same("terra_review.model", receipt.terra_review.model, expected.terra.model);
  same("terra_review.reasoning_effort", receipt.terra_review.reasoning_effort, expected.terra.reasoningEffort);
  same("sol_review.model", receipt.sol_review.model, expected.sol.model);
  same("sol_review.reasoning_effort", receipt.sol_review.reasoning_effort, expected.sol.reasoningEffort);
  if (mismatches.length > 0) throw new RevisionError("REVISION_STATE_INVALID", `Persisted revision checkpoint attempts to redefine sealed authority: ${mismatches.join(", ")}.`);
}
