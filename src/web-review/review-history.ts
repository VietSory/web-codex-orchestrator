import crypto from "node:crypto";
import { WebReviewError } from "./contracts.js";
import type { WebReviewReceipt } from "./contracts.js";
import { resolveReviewRoundPaths, reviewRoundDirectoryExistsAndIsSafe } from "./web-review-paths.js";
import { readWebReviewReceipt, readCanonicalArtifact } from "./web-review-store.js";
import type { LoadedResultBundle } from "./result-bundle-review-reader.js";

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface IdempotencyCheckResult {
  isSealed: boolean;
  isIdempotent: boolean;
  existingReceipt: WebReviewReceipt | null;
  existingEventBuffer: Buffer | null;
  existingRevisionRequestBuffer: Buffer | null;
  existingVerdictBuffer: Buffer | null;
}

export interface ReviewHistoryValidationResult {
  previousReceipt: WebReviewReceipt | null;
  previousRevisionRequestData: unknown | null;
  previousVerdictData: unknown | null;
}

/**
 * Check if current round is already sealed.
 * If sealed with the EXACT same canonical verdict sha256 -> return idempotent match.
 * If sealed with a DIFFERENT verdict sha256 -> throw WEB_REVIEW_ALREADY_SEALED.
 */
export async function checkRoundIdempotency(
  stateDirectory: string,
  runId: string,
  round: number,
  incomingVerdictSha256: string
): Promise<IdempotencyCheckResult> {
  const paths = resolveReviewRoundPaths(stateDirectory, runId, round);
  if (!(await reviewRoundDirectoryExistsAndIsSafe(stateDirectory, paths.roundDir))) {
    return {
      isSealed: false,
      isIdempotent: false,
      existingReceipt: null,
      existingEventBuffer: null,
      existingRevisionRequestBuffer: null,
      existingVerdictBuffer: null,
    };
  }
  const existingReceipt = await readWebReviewReceipt(paths.receiptPath);

  if (!existingReceipt) {
    return {
      isSealed: false,
      isIdempotent: false,
      existingReceipt: null,
      existingEventBuffer: null,
      existingRevisionRequestBuffer: null,
      existingVerdictBuffer: null,
    };
  }

  const isTerminalState =
    existingReceipt.state === "APPROVED" ||
    existingReceipt.state === "REVISION_REQUESTED" ||
    existingReceipt.state === "ESCALATED";

  if (!isTerminalState) {
    return {
      isSealed: false,
      isIdempotent: false,
      existingReceipt,
      existingEventBuffer: null,
      existingRevisionRequestBuffer: null,
      existingVerdictBuffer: null,
    };
  }

  if (existingReceipt.verdict_sha256 === incomingVerdictSha256) {
    const existingEventBuffer = await readCanonicalArtifact(paths.decisionEventPath);
    const existingRevisionRequestBuffer = await readCanonicalArtifact(paths.revisionRequestPath);
    const existingVerdictBuffer = await readCanonicalArtifact(paths.verdictPath);
    return {
      isSealed: true,
      isIdempotent: true,
      existingReceipt,
      existingEventBuffer,
      existingRevisionRequestBuffer,
      existingVerdictBuffer,
    };
  }

  throw new WebReviewError(
    "WEB_REVIEW_ALREADY_SEALED",
    `Review round ${round} is already sealed with a different verdict (existing sha256: ${existingReceipt.verdict_sha256}, incoming sha256: ${incomingVerdictSha256}).`
  );
}

/** Validate history chain for initial (round 1) or revision (round > 1) reviews. */
export async function validateReviewHistory(
  stateDirectory: string,
  runId: string,
  round: number,
  verdict: any,
  currentBundle: LoadedResultBundle
): Promise<ReviewHistoryValidationResult> {
  void currentBundle;
  if (round === 1) {
    if (
      verdict.previous_result_bundle_sha256 !== null ||
      verdict.previous_verdict_sha256 !== null ||
      verdict.revision_request_sha256 !== null ||
      verdict.previous_published_commit_sha !== null
    ) {
      throw new WebReviewError(
        "WEB_REVIEW_HISTORY_INVALID",
        "Initial review round 1 requires all previous round hash fields to be null."
      );
    }
    if (verdict.review_mode !== "INITIAL") {
      throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", "Round 1 verdict review_mode must be 'INITIAL'.");
    }
    return { previousReceipt: null, previousRevisionRequestData: null, previousVerdictData: null };
  }

  if (verdict.review_mode !== "REVISION") {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Round ${round} verdict review_mode must be 'REVISION'.`);
  }

  const prevRound = round - 1;
  const prevPaths = resolveReviewRoundPaths(stateDirectory, runId, prevRound);
  if (!(await reviewRoundDirectoryExistsAndIsSafe(stateDirectory, prevPaths.roundDir))) {
    throw new WebReviewError(
      "WEB_REVIEW_HISTORY_INVALID",
      `Missing previous review round ${prevRound} directory. Cannot skip review rounds.`
    );
  }
  const prevReceipt = await readWebReviewReceipt(prevPaths.receiptPath);

  if (!prevReceipt) {
    throw new WebReviewError(
      "WEB_REVIEW_HISTORY_INVALID",
      `Missing previous review round ${prevRound} receipt. Cannot skip review rounds.`
    );
  }

  if (prevReceipt.state !== "REVISION_REQUESTED") {
    throw new WebReviewError(
      "WEB_REVIEW_HISTORY_INVALID",
      `Previous review round ${prevRound} state is '${prevReceipt.state}', expected 'REVISION_REQUESTED'.`
    );
  }

  if (verdict.previous_result_bundle_sha256 !== prevReceipt.result_bundle_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `previous_result_bundle_sha256 mismatch. Expected '${prevReceipt.result_bundle_sha256}', got '${verdict.previous_result_bundle_sha256}'.`);
  }
  if (verdict.previous_verdict_sha256 !== prevReceipt.verdict_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `previous_verdict_sha256 mismatch. Expected '${prevReceipt.verdict_sha256}', got '${verdict.previous_verdict_sha256}'.`);
  }
  if (verdict.revision_request_sha256 !== prevReceipt.revision_request_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `revision_request_sha256 mismatch. Expected '${prevReceipt.revision_request_sha256}', got '${verdict.revision_request_sha256}'.`);
  }
  if (verdict.previous_published_commit_sha !== prevReceipt.published_commit_sha) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `previous_published_commit_sha mismatch. Expected '${prevReceipt.published_commit_sha}', got '${verdict.previous_published_commit_sha}'.`);
  }
  if (verdict.spec_set_sha256 !== prevReceipt.spec_set_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", "spec_set_sha256 mismatch across rounds. Spec set must be frozen.");
  }
  if (verdict.pull_request_number !== prevReceipt.pull_request_number) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `pull_request_number mismatch across rounds. Expected ${prevReceipt.pull_request_number}, got ${verdict.pull_request_number}.`);
  }

  const prevVerdictBuf = await readCanonicalArtifact(prevPaths.verdictPath);
  if (!prevVerdictBuf) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Missing previous round ${prevRound} verdict artifact file.`);
  }
  const prevVerdictSha = sha256Hex(prevVerdictBuf);
  if (prevVerdictSha !== prevReceipt.verdict_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Previous round ${prevRound} verdict artifact SHA mismatch on disk (expected '${prevReceipt.verdict_sha256}', got '${prevVerdictSha}').`);
  }

  let previousVerdictData: unknown;
  try {
    previousVerdictData = JSON.parse(prevVerdictBuf.toString("utf8"));
  } catch {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Previous round ${prevRound} verdict artifact is malformed JSON.`);
  }

  const prevRevReqBuf = await readCanonicalArtifact(prevPaths.revisionRequestPath);
  if (!prevRevReqBuf) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Missing previous round ${prevRound} revision request artifact file.`);
  }
  const prevRevReqSha = sha256Hex(prevRevReqBuf);
  if (prevRevReqSha !== prevReceipt.revision_request_sha256) {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Previous round ${prevRound} revision request artifact SHA mismatch on disk (expected '${prevReceipt.revision_request_sha256}', got '${prevRevReqSha}').`);
  }

  let previousRevisionRequestData: unknown;
  try {
    previousRevisionRequestData = JSON.parse(prevRevReqBuf.toString("utf8"));
  } catch {
    throw new WebReviewError("WEB_REVIEW_HISTORY_INVALID", `Previous round ${prevRound} revision request artifact is malformed JSON.`);
  }

  return { previousReceipt: prevReceipt, previousRevisionRequestData, previousVerdictData };
}
