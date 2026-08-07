import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { RevisionError, type RevisionReceipt } from "./contracts.js";

function lexicalCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

async function computeAcceptedBundleTree(bundlePath: string): Promise<string> {
  const resolved = path.resolve(bundlePath);
  const rootStat = await fs.lstat(resolved).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle cannot be inspected: ${error instanceof Error ? error.message : String(error)}`); });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted bundle must remain a real directory.");
  const files = (await fs.readdir(resolved)).sort(lexicalCompare);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const full = path.join(resolved, file);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle contains an unsafe entry '${file}'.`);
    if (!stat.isFile()) continue;
    hash.update(file);
    hash.update(await fs.readFile(full));
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
  await verifyBundleChecksums(bundlePath).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", `Accepted bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`); });
  const actual = await computeAcceptedBundleTree(bundlePath);
  if (actual !== expectedTreeSha256) throw new RevisionError("REVISION_BUNDLE_MUTATED", "Accepted Task Bundle no longer matches the tree sealed by the previous verified Result Bundle.");
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

/** A mutable checkpoint may record progress; it may never redefine authority. */
export function assertRevisionReceiptAuthority(receipt: RevisionReceipt, expected: RevisionReceiptAuthority): void {
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
