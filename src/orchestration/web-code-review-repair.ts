import type { ReviewerRepairOperation } from "../execution/contracts.js";
import { createProductionVerifier } from "../executor/production-gates.js";
import { bindWebReviewRepair } from "../executor/repair.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import { readExecutorReceipt } from "../executor/store.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { contentDigest, WebBridgeError, type WebVerdictEnvelope } from "../web-bridge/contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
function splitRunId(runId: string): { taskId: string; archiveSha: string } { const split = runId.lastIndexOf(":"); const taskId = runId.slice(0, split), archiveSha = runId.slice(split + 1); if (split < 1 || !SHA256.test(archiveSha)) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_INVALID", "Run identity is invalid for Web repair."); return { taskId, archiveSha }; }

/**
 * Apply one bounded Web repair generation through the shared Harness.
 * PAIR accepts Web-B or original Web-A repair authority. AUTOPILOT accepts only
 * a later original Web-A repair whose source digest remains chained to the one
 * frozen Sol/Terra pass. The Web supplies exact bytes/preimages but never owns
 * mutation. A different prior generation may rotate only after VERIFIED; an
 * in-flight different generation always conflicts fail-closed.
 */
export async function applyHarnessWebRepair(options: { envelope: WebVerdictEnvelope; stateDirectory: string; configPath: string; now?: () => Date; }) {
  if (options.envelope.verdict !== "REVISE" || !options.envelope.repair_operations?.length) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_MISSING", "A bounded Web repair requires a REVISE verdict with repair_operations.");
  const selected = await readSelectedArtifact(options.stateDirectory, options.envelope.run_id);
  if (!selected) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_INVALID", "No selected registered artifact exists for Web repair.");
  const id = splitRunId(options.envelope.run_id);
  const receipt = await readExecutorReceipt(options.stateDirectory, id.taskId, id.archiveSha, selected.artifact_sha256);
  if (!receipt || receipt.run_id !== options.envelope.run_id || receipt.artifact_sha256 !== selected.artifact_sha256) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_INVALID", "Exact executor authority is unavailable for Web repair.");
  const pairAuthority = receipt.review_strategy === "web" && receipt.reviewer_selection === undefined;
  const autopilotAuthority = receipt.review_strategy === "model" && receipt.reviewer_selection !== undefined;
  if (!pairAuthority && !autopilotAuthority) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_INVALID", "Web repair is valid only for a frozen Harness-first PAIR or AUTOPILOT executor.");
  const reviewStrategy = pairAuthority ? "web" as const : "model" as const;

  const evidenceSha256 = contentDigest(options.envelope);
  const sameCurrent = receipt.repair?.reviewer === "web" && receipt.repair.source_review_evidence_sha256 === evidenceSha256;
  if (receipt.repair && !sameCurrent && receipt.repair.state !== "VERIFIED") throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_CONFLICT", "A different in-flight repair authority is already bound to this executor.");
  if (!sameCurrent) {
    if (!receipt.change_set_digest || !receipt.verification.passed || receipt.verification.change_set_digest !== receipt.change_set_digest) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_INVALID", "Web repair requires an exact deterministically verified source change-set.");
    await bindWebReviewRepair({ stateDirectory: options.stateDirectory, receipt, sourceChangeSetDigest: receipt.change_set_digest, sourceReviewEvidenceSha256: evidenceSha256, operations: options.envelope.repair_operations as ReviewerRepairOperation[], ...(options.now ? { now: options.now } : {}) });
  }

  const verifier = await createProductionVerifier({ runId: options.envelope.run_id, stateDirectory: options.stateDirectory, configPath: options.configPath });
  const repaired = await executeRegisteredWebPack({
    runId: options.envelope.run_id,
    artifactSha256: selected.artifact_sha256,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    verifier,
    reviewStrategy,
    ...(options.now ? { now: options.now } : {}),
  });
  if (repaired.state !== "READY_FOR_PUBLISH" || repaired.repair?.reviewer !== "web" || repaired.repair.state !== "VERIFIED" || !repaired.repair.final_change_set_digest || repaired.change_set_digest !== repaired.repair.final_change_set_digest) throw new WebBridgeError("WEB_CODE_REVIEW_REPAIR_FAILED", `Harness Web repair stopped in ${repaired.state} without an exact verified repaired snapshot.`);
  return repaired;
}

/** Backward-compatible names for existing PAIR callers/tests. */
export const applyPairWebRepair = applyHarnessWebRepair;
export const applyWebCodeReviewRepair = applyHarnessWebRepair;
