import crypto from "node:crypto";
import type { GitPublishReceipt } from "./contracts.js";

/**
 * Frozen Phase 5B authority digest for a validated Git publish receipt.
 * Keep this representation centralized: Draft PR creation, Result packaging,
 * and recovery must bind the same semantic receipt fields in the same order.
 */
export function canonicalGitPublishReceiptDigest(receipt: GitPublishReceipt): string {
  const explicit = JSON.stringify([
    "publish_version", receipt.publish_version,
    "run_id", receipt.run_id,
    "state", receipt.state,
    "base_commit", receipt.base_commit,
    "branch_name", receipt.branch_name,
    "remote_name", receipt.remote_name,
    "allowed_remote_url", receipt.allowed_remote_url,
    "change_set_sha256", receipt.change_set_sha256,
    "expected_paths", receipt.expected_paths,
    "approved_snapshot_sha256", receipt.approved_snapshot_sha256,
    "commit_sha", receipt.commit_sha,
    "remote_branch_sha", receipt.remote_branch_sha,
    "created_at", receipt.created_at,
    "updated_at", receipt.updated_at,
    "committed_at", receipt.committed_at,
    "pushed_at", receipt.pushed_at,
  ]);
  return crypto.createHash("sha256").update(explicit, "utf8").digest("hex");
}
