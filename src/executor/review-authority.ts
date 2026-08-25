import type { ExecutorReceipt, ExecutorRepairHistoryEntry } from "./contracts.js";

function selectedReview(receipt: ExecutorReceipt) {
  return receipt.reviewer_selection?.kind === "terra"
    ? receipt.terra_review
    : receipt.reviewer_selection?.kind === "sol"
      ? receipt.sol_review
      : null;
}

function browserRepairReapproved(receipt: ExecutorReceipt, digest: string): boolean {
  const reapproval = receipt.repair_reapproval;
  return Boolean(
    reapproval?.rounds === 1 &&
    reapproval.verdict === "APPROVE" &&
    reapproval.change_set_digest === digest &&
    reapproval.evidence_sha256,
  );
}

function modelHistoryAnchor(receipt: ExecutorReceipt): string | null {
  if (receipt.review_strategy !== "model" || !receipt.reviewer_selection) return null;
  const review = selectedReview(receipt);
  if (!review) return null;
  const history = receipt.repair_history ?? [];
  if (history.length === 0) return null;

  const first = history[0]!;
  let current: string;
  if (first.reviewer === receipt.reviewer_selection.kind) {
    if (
      review.verdict !== "REVISE" ||
      review.change_set_digest !== first.source_change_set_digest ||
      review.evidence_sha256 !== first.source_review_evidence_sha256 ||
      (receipt.reviewer_selection.model === "chatgpt-web" && !browserRepairReapproved(receipt, first.final_change_set_digest))
    ) return null;
    current = first.final_change_set_digest;
  } else if (first.reviewer === "web") {
    if (review.verdict !== "APPROVE" || review.change_set_digest !== first.source_change_set_digest) return null;
    current = first.final_change_set_digest;
  } else return null;

  for (let index = 1; index < history.length; index += 1) {
    const entry: ExecutorRepairHistoryEntry = history[index]!;
    if (entry.reviewer !== "web" || entry.source_change_set_digest !== current) return null;
    current = entry.final_change_set_digest;
  }
  return current;
}

/**
 * Returns true only when the selected model authority covers the supplied
 * digest. Browser PAIR is stricter than legacy model review: if the selected
 * ChatGPT Web reviewer proposed a repair, a fresh review must APPROVE the exact
 * repaired digest before that repair can anchor any later authority chain.
 */
export function selectedModelAuthorityCoversDigest(receipt: ExecutorReceipt, digest: string): boolean {
  if (receipt.review_strategy !== "model" || !receipt.reviewer_selection) return false;
  const review = selectedReview(receipt);
  if (!review) return false;
  if (review.verdict === "APPROVE" && review.change_set_digest === digest) return true;

  const repair = receipt.repair;
  if (
    repair?.reviewer === receipt.reviewer_selection.kind &&
    repair.state === "VERIFIED" &&
    repair.final_change_set_digest === digest &&
    review.verdict === "REVISE" &&
    review.change_set_digest === repair.source_change_set_digest &&
    review.evidence_sha256 === repair.source_review_evidence_sha256
  ) {
    return receipt.reviewer_selection.model === "chatgpt-web"
      ? browserRepairReapproved(receipt, digest)
      : true;
  }

  return modelHistoryAnchor(receipt) === digest;
}

/**
 * Final Web-A repair may advance a model-reviewed AUTOPILOT digest without a
 * second model call, but only when its source is already covered by the frozen
 * model authority and the final bytes passed deterministic verification.
 */
export function finalWebRepairCompletesModelAuthority(receipt: ExecutorReceipt, digest: string): boolean {
  const repair = receipt.repair;
  return Boolean(
    receipt.review_strategy === "model" &&
    repair?.reviewer === "web" &&
    repair.state === "VERIFIED" &&
    repair.final_change_set_digest === digest &&
    selectedModelAuthorityCoversDigestWithoutCurrentWeb(receipt, repair.source_change_set_digest),
  );
}

function selectedModelAuthorityCoversDigestWithoutCurrentWeb(receipt: ExecutorReceipt, digest: string): boolean {
  if (receipt.review_strategy !== "model" || !receipt.reviewer_selection) return false;
  const review = selectedReview(receipt);
  if (!review) return false;
  if (review.verdict === "APPROVE" && review.change_set_digest === digest) return true;
  return modelHistoryAnchor(receipt) === digest;
}
