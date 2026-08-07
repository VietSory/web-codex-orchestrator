import crypto from "node:crypto";
import { RevisionError, type RevisionRequest } from "./contracts.js";
import { resolveReviewRoundPaths, reviewRoundDirectoryExistsAndIsSafe } from "../web-review/web-review-paths.js";
import { readCanonicalArtifact, readWebReviewReceipt } from "../web-review/web-review-store.js";
import { loadAndVerifyResultBundle, type LoadedResultBundle } from "../web-review/result-bundle-review-reader.js";

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertHex(value: unknown, length: 40 | 64, field: string): asserts value is string {
  const pattern = length === 64 ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RevisionError("REVISION_REQUEST_INVALID", `${field} must be a ${length}-hex lowercase digest.`);
  }
}

export function assertRevisionRequest(value: unknown): asserts value is RevisionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RevisionError("REVISION_REQUEST_INVALID", "revision-request.json must contain a JSON object.");
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_version", "run_id", "revision_round", "spec_set_sha256",
    "previous_result_bundle_sha256", "previous_verdict_sha256",
    "previous_published_commit_sha", "previous_pr_head_sha",
    "pull_request_number", "findings",
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new RevisionError("REVISION_REQUEST_INVALID", `revision-request.json contains unknown field '${key}'.`);
  }
  if (obj.schema_version !== "1.1") throw new RevisionError("REVISION_REQUEST_INVALID", "revision-request schema_version must be 1.1.");
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0 || obj.run_id.length > 256) throw new RevisionError("REVISION_REQUEST_INVALID", "revision-request run_id is invalid.");
  if (!Number.isInteger(obj.revision_round) || Number(obj.revision_round) < 1 || Number(obj.revision_round) > 3) throw new RevisionError("REVISION_REQUEST_INVALID", "revision_round must be between 1 and 3.");
  assertHex(obj.spec_set_sha256, 64, "spec_set_sha256");
  assertHex(obj.previous_result_bundle_sha256, 64, "previous_result_bundle_sha256");
  assertHex(obj.previous_verdict_sha256, 64, "previous_verdict_sha256");
  assertHex(obj.previous_published_commit_sha, 40, "previous_published_commit_sha");
  assertHex(obj.previous_pr_head_sha, 40, "previous_pr_head_sha");
  if (!Number.isInteger(obj.pull_request_number) || Number(obj.pull_request_number) < 1) throw new RevisionError("REVISION_REQUEST_INVALID", "pull_request_number must be a positive integer.");
  if (!Array.isArray(obj.findings) || obj.findings.length < 1 || obj.findings.length > 256) throw new RevisionError("REVISION_REQUEST_INVALID", "findings must contain between 1 and 256 entries.");
  const ids = new Set<string>();
  for (const rawFinding of obj.findings) {
    if (typeof rawFinding !== "object" || rawFinding === null || Array.isArray(rawFinding)) throw new RevisionError("REVISION_REQUEST_INVALID", "revision finding must be an object.");
    const finding = rawFinding as Record<string, unknown>;
    const findingId = finding.finding_id;
    if (typeof findingId !== "string" || !/^WEB-FIND-[0-9]{3,}$/.test(findingId) || ids.has(findingId)) throw new RevisionError("REVISION_REQUEST_INVALID", `Invalid or duplicate finding_id '${String(findingId)}'.`);
    ids.add(findingId);
    if (!["SPEC_VIOLATION", "IMPLEMENTATION_DEFECT", "EVIDENCE_GAP", "REPOSITORY_DRIFT"].includes(String(finding.classification))) throw new RevisionError("REVISION_REQUEST_INVALID", `Invalid revision classification for ${findingId}.`);
    if (!["INITIAL_DISCOVERY", "PREVIOUS_UNRESOLVED", "REVISION_REGRESSION", "REVISION_EVIDENCE_INVALIDATION"].includes(String(finding.finding_origin))) throw new RevisionError("REVISION_REQUEST_INVALID", `Invalid finding_origin for ${findingId}.`);
    for (const arrayField of ["locked_reference_ids", "artifact_paths"] as const) {
      const values = finding[arrayField];
      if (!Array.isArray(values) || values.length < 1 || values.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new RevisionError("REVISION_REQUEST_INVALID", `${findingId}.${arrayField} must be a non-empty string array.`);
    }
    for (const stringField of ["line_or_json_pointer", "evidence", "minimal_required_fix"] as const) {
      if (typeof finding[stringField] !== "string" || finding[stringField].length === 0) throw new RevisionError("REVISION_REQUEST_INVALID", `${findingId}.${stringField} must be non-empty.`);
    }
  }
}

export interface LoadedRevisionSource {
  request: RevisionRequest;
  requestBuffer: Buffer;
  requestSha256: string;
  previousVerdictBuffer: Buffer;
  previousDecisionEventBuffer: Buffer;
  previousResultBundle: LoadedResultBundle;
}

/**
 * Independently reconstruct the Phase 7 revision authority. Nothing outside
 * the sealed Phase 7 round can authorize a Phase 8 revision.
 */
export async function loadSealedRevisionSource(
  stateDirectory: string,
  runId: string,
  revisionRound: number
): Promise<LoadedRevisionSource> {
  if (!Number.isInteger(revisionRound) || revisionRound < 1 || revisionRound > 3) {
    throw new RevisionError("REVISION_REQUEST_INVALID", `Revision round must be between 1 and 3; got ${revisionRound}`);
  }
  const reviewPaths = resolveReviewRoundPaths(stateDirectory, runId, revisionRound);
  if (!(await reviewRoundDirectoryExistsAndIsSafe(stateDirectory, reviewPaths.roundDir))) {
    throw new RevisionError("REVISION_HISTORY_INVALID", `Phase 7 review round ${revisionRound} does not exist.`);
  }
  const receipt = await readWebReviewReceipt(reviewPaths.receiptPath);
  if (!receipt || receipt.run_id !== runId || receipt.review_round !== revisionRound) {
    throw new RevisionError("REVISION_HISTORY_INVALID", `Phase 7 review receipt ${revisionRound} is missing or has the wrong identity.`);
  }
  if (receipt.state !== "REVISION_REQUESTED" || receipt.action !== "NO_USER_MERGE_PROMPT") {
    throw new RevisionError("REVISION_HISTORY_INVALID", `Phase 7 review round ${revisionRound} is not a sealed REVISION_REQUESTED terminal.`);
  }
  if (!receipt.verdict_sha256 || !receipt.revision_request_sha256 || !receipt.decision_event_sha256 || !receipt.fresh_attested_head_sha) {
    throw new RevisionError("REVISION_HISTORY_INVALID", "Phase 7 revision receipt has incomplete terminal hash or attestation bindings.");
  }

  const [requestBuffer, verdictBuffer, decisionBuffer] = await Promise.all([
    readCanonicalArtifact(reviewPaths.revisionRequestPath),
    readCanonicalArtifact(reviewPaths.verdictPath),
    readCanonicalArtifact(reviewPaths.decisionEventPath),
  ]);
  if (!requestBuffer || !verdictBuffer || !decisionBuffer) throw new RevisionError("REVISION_HISTORY_INVALID", "Phase 7 revision terminal is missing one or more canonical artifacts.");

  const requestSha256 = sha256Hex(requestBuffer);
  const verdictSha256 = sha256Hex(verdictBuffer);
  const decisionSha256 = sha256Hex(decisionBuffer);
  if (requestSha256 !== receipt.revision_request_sha256) throw new RevisionError("REVISION_HISTORY_INVALID", "revision-request.json hash does not match the Phase 7 receipt.");
  if (verdictSha256 !== receipt.verdict_sha256) throw new RevisionError("REVISION_HISTORY_INVALID", "Previous Web verdict hash does not match the Phase 7 receipt.");
  if (decisionSha256 !== receipt.decision_event_sha256) throw new RevisionError("REVISION_HISTORY_INVALID", "Previous decision event hash does not match the Phase 7 receipt.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBuffer.toString("utf8"));
  } catch (error) {
    throw new RevisionError("REVISION_REQUEST_INVALID", `revision-request.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertRevisionRequest(parsed);
  const request = parsed;

  // The previous Web review round and the previous Result Bundle round have
  // the same number: round 1 reviewed the initial bundle; round N reviewed
  // revision bundle N-1 for N > 1.
  const previousResultBundle = await loadAndVerifyResultBundle(stateDirectory, runId, revisionRound);
  const exactSchema = previousResultBundle.embeddedContracts.compiledRevisionRequestValidator;
  if (!exactSchema(request)) {
    throw new RevisionError("REVISION_REQUEST_INVALID", `Sealed revision request fails the exact schema embedded in its reviewed Result Bundle: ${previousResultBundle.embeddedContracts.revisionRequestSchemaErrors() ?? "unknown schema error"}`);
  }

  if (request.run_id !== runId || request.revision_round !== revisionRound) throw new RevisionError("REVISION_HISTORY_INVALID", "Revision request run/round identity does not match the sealed Phase 7 receipt.");
  if (request.spec_set_sha256 !== receipt.spec_set_sha256 || request.spec_set_sha256 !== previousResultBundle.receipt.spec_set_sha256) throw new RevisionError("REVISION_SPEC_DRIFT", "Frozen spec_set_sha256 does not match across Phase 7, the revision request and the previous Result Bundle.");
  if (request.previous_result_bundle_sha256 !== receipt.result_bundle_sha256 || request.previous_result_bundle_sha256 !== previousResultBundle.receipt.archive_sha256) throw new RevisionError("REVISION_HISTORY_INVALID", "Previous Result Bundle SHA binding mismatch.");
  if (request.previous_verdict_sha256 !== receipt.verdict_sha256) throw new RevisionError("REVISION_HISTORY_INVALID", "Previous verdict SHA binding mismatch.");
  if (request.previous_published_commit_sha !== receipt.published_commit_sha || request.previous_published_commit_sha !== previousResultBundle.receipt.published_commit_sha) throw new RevisionError("REVISION_HEAD_DRIFT", "Previous published commit binding mismatch.");
  if (request.previous_pr_head_sha !== receipt.observed_head_sha || request.previous_pr_head_sha !== receipt.fresh_attested_head_sha || request.previous_pr_head_sha !== previousResultBundle.receipt.pull_request.head_sha) throw new RevisionError("REVISION_HEAD_DRIFT", "Previous PR head binding mismatch.");
  if (request.pull_request_number !== receipt.pull_request_number || request.pull_request_number !== previousResultBundle.receipt.pull_request.number) throw new RevisionError("REVISION_PR_DRIFT", "Pull Request number binding mismatch.");
  if (previousResultBundle.receipt.pull_request.draft !== true) throw new RevisionError("REVISION_PR_DRIFT", "Previous Result Bundle did not attest a Draft Pull Request.");

  return {
    request,
    requestBuffer,
    requestSha256,
    previousVerdictBuffer: verdictBuffer,
    previousDecisionEventBuffer: decisionBuffer,
    previousResultBundle,
  };
}
