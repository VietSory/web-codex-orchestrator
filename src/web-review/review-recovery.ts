import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebReviewError, type WebReviewReceipt, type WebReviewState, type WebReviewVerdict } from "./contracts.js";
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

/**
 * Inspect existing review persistence state under owned round lock for crash recovery & idempotency (P0-11, P0-14).
 * Compares incoming verdict bytes against sealed disk state.
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

  // Check sealed verdict file
  const verdictPath = path.join(roundDir, "web-review-verdict.json");
  let verdictSha256: string | null = null;
  let verdictMatches = false;
  try {
    const verdictBytes = await fs.readFile(verdictPath);
    verdictSha256 = sha256Hex(verdictBytes);
    if (verdictSha256 === incomingVerdictSha256) {
      verdictMatches = true;
    }
  } catch {
    // Verdict file missing or unreadable
  }

  // Check sealed decision event file
  const decisionEventPath = path.join(roundDir, "decision-event.json");
  let decisionEventSha256: string | null = null;
  try {
    const eventBytes = await fs.readFile(decisionEventPath);
    decisionEventSha256 = sha256Hex(eventBytes);
  } catch {
    // File missing
  }

  // Check sealed revision request file
  const revisionRequestPath = path.join(roundDir, "revision-request.json");
  let revisionRequestSha256: string | null = null;
  try {
    const revBytes = await fs.readFile(revisionRequestPath);
    revisionRequestSha256 = sha256Hex(revBytes);
  } catch {
    // File missing
  }

  return {
    existingReceipt,
    recoveredState: existingReceipt.state,
    verdictMatches,
    verdictSha256,
    revisionRequestSha256,
    decisionEventSha256,
  };
}
