import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ExecutorError, type ExecutorUsage } from "./contracts.js";

export interface ExecutorVerificationRequest {
  run_id: string;
  artifact_sha256: string;
  worktree_path: string;
  accepted_bundle_path: string;
  change_set_digest: string;
  changed_paths: string[];
  signal?: AbortSignal;
}

export interface ExecutorVerificationResult {
  passed: boolean;
  evidence: unknown;
}

export interface ExecutorVerifierPort {
  verify(request: ExecutorVerificationRequest): Promise<ExecutorVerificationResult>;
}

export interface ExecutorReviewRequest extends ExecutorVerificationRequest {
  reviewer: "terra" | "sol";
  prior_evidence_sha256: string[];
}

export interface ExecutorReviewResult {
  verdict: "APPROVE" | "REVISE" | "ESCALATE";
  evidence: unknown;
  usage?: ExecutorUsage;
}

export interface ExecutorReviewerPort {
  review(request: ExecutorReviewRequest): Promise<ExecutorReviewResult>;
}

export function boundedEvidence(value: unknown, maximumBytes = 512 * 1024): { bytes: Buffer; sha256: string } {
  let bytes: Buffer;
  try { bytes = canonicalJsonBuffer(value); }
  catch (error) { throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Gate evidence is not canonical-JSON serializable: ${error instanceof Error ? error.message : String(error)}`); }
  if (bytes.byteLength > maximumBytes) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Gate evidence exceeds ${maximumBytes} bytes.`);
  return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
