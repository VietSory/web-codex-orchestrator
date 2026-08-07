import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebReviewError, type WebReviewReceipt, type WebReviewState } from "./contracts.js";
import { readWebReviewReceipt } from "./web-review-store.js";

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface InspectionResult {
  existingReceipt: WebReviewReceipt | null;
  recoveredState: WebReviewState | null;
  verdictMatches: boolean;
  verdictSha256: string | null;
  revisionRequestSha256: string | null;
  decisionEventSha256: string | null;
}

async function hashIfPresent(filePath: string): Promise<string | null> {
  try {
    return sha256Hex(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WebReviewError(
      "WEB_REVIEW_RECEIPT_INVALID",
      `Cannot inspect persisted review artifact '${filePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Inspect round persistence under the owned round lock.
 *
 * A receipt is a write-ahead binding to the first canonical verdict submitted
 * for the round. Terminal receipts are idempotent only when every terminal
 * artifact still exists and hashes exactly to the values sealed in the receipt.
 */
export async function inspectReviewPersistence(
  roundDir: string,
  incomingVerdictSha256: string
): Promise<InspectionResult> {
  const receiptPath = path.join(roundDir, "web-review-receipt.json");
  const existingReceipt = await readWebReviewReceipt(receiptPath);

  if (!existingReceipt) {
    return {
      existingReceipt: null,
      recoveredState: null,
      verdictMatches: false,
      verdictSha256: null,
      revisionRequestSha256: null,
      decisionEventSha256: null,
    };
  }

  if (existingReceipt.verdict_sha256 && existingReceipt.verdict_sha256 !== incomingVerdictSha256) {
    throw new WebReviewError(
      "WEB_REVIEW_ALREADY_SEALED",
      `Review round ${existingReceipt.review_round} is already sealed with a different verdict.`
    );
  }

  const verdictPath = path.join(roundDir, "web-review-verdict.json");
  const decisionEventPath = path.join(roundDir, "decision-event.json");
  const revisionRequestPath = path.join(roundDir, "revision-request.json");

  const verdictSha256 = await hashIfPresent(verdictPath);
  const decisionEventSha256 = await hashIfPresent(decisionEventPath);
  const revisionRequestSha256 = await hashIfPresent(revisionRequestPath);

  if (verdictSha256 && existingReceipt.verdict_sha256 && verdictSha256 !== existingReceipt.verdict_sha256) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Persisted verdict artifact hash does not match its receipt.");
  }
  if (decisionEventSha256 && existingReceipt.decision_event_sha256 && decisionEventSha256 !== existingReceipt.decision_event_sha256) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Persisted decision event hash does not match its receipt.");
  }
  if (revisionRequestSha256 && existingReceipt.revision_request_sha256 && revisionRequestSha256 !== existingReceipt.revision_request_sha256) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Persisted revision request hash does not match its receipt.");
  }

  const terminal =
    existingReceipt.state === "APPROVED" ||
    existingReceipt.state === "REVISION_REQUESTED" ||
    existingReceipt.state === "ESCALATED";

  if (terminal) {
    if (!existingReceipt.verdict_sha256 || verdictSha256 !== existingReceipt.verdict_sha256) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Terminal review receipt is missing its exact persisted verdict artifact.");
    }
    if (!existingReceipt.decision_event_sha256 || decisionEventSha256 !== existingReceipt.decision_event_sha256) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Terminal review receipt is missing its exact persisted decision event.");
    }

    if (existingReceipt.state === "REVISION_REQUESTED") {
      if (!existingReceipt.revision_request_sha256 || revisionRequestSha256 !== existingReceipt.revision_request_sha256) {
        throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "REVISION_REQUESTED receipt is missing its exact revision request artifact.");
      }
    } else if (existingReceipt.revision_request_sha256 !== null || revisionRequestSha256 !== null) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${existingReceipt.state} round must not contain a revision request artifact.`);
    }
  }

  return {
    existingReceipt,
    recoveredState: existingReceipt.state,
    verdictMatches: existingReceipt.verdict_sha256 === incomingVerdictSha256,
    verdictSha256,
    revisionRequestSha256,
    decisionEventSha256,
  };
}
