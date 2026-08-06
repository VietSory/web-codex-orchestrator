// Canonical revision-request.json builder and schema validator for Phase 7
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020Mod from "ajv/dist/2020.js";
import { WebReviewError } from "./contracts.js";
import type { RevisionRequest, RevisionFinding, WebReviewVerdict, VerdictBlockingFinding } from "./contracts.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";

const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface BuiltRevisionRequest {
  revisionRequest: RevisionRequest;
  canonicalBuffer: Buffer;
  revisionRequestSha256: string;
}

/**
 * Build canonical `revision-request.json` from a validated REVISE verdict,
 * validate against embedded schema 1.1, and return canonical buffer & SHA-256.
 */
export function buildRevisionRequest(
  verdict: WebReviewVerdict,
  verdictSha256: string
): BuiltRevisionRequest {
  if (verdict.verdict !== "REVISE") {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", "Cannot build revision request for non-REVISE verdict.");
  }

  const findings: RevisionFinding[] = verdict.blocking_findings.map((f: VerdictBlockingFinding) => ({
    finding_id: f.finding_id,
    classification: f.classification as RevisionFinding["classification"],
    finding_origin: f.finding_origin as RevisionFinding["finding_origin"],
    previous_finding_id: f.previous_finding_id,
    locked_reference_ids: [...f.locked_reference_ids],
    artifact_paths: [...f.artifact_paths],
    line_or_json_pointer: f.line_or_json_pointer,
    expected_behavior: f.expected_behavior,
    observed_behavior: f.observed_behavior,
    evidence: f.evidence,
    minimal_required_fix: f.minimal_required_fix,
    revision_changed_paths: [...f.revision_changed_paths],
  }));

  const revisionRequest: RevisionRequest = {
    schema_version: "1.1",
    kind: "wco-revision-request",
    run_id: verdict.run_id,
    revision_round: verdict.review_round,
    spec_set_sha256: verdict.spec_set_sha256,
    previous_result_bundle_sha256: verdict.result_bundle_sha256,
    previous_verdict_sha256: verdictSha256,
    previous_published_commit_sha: verdict.published_commit_sha,
    previous_pr_head_sha: verdict.observed_head_sha,
    pull_request_number: verdict.pull_request_number,
    findings,
  };

  // Schema validation against embedded revision-request.schema.json
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemaPath = path.join(__dirname, "..", "result-bundle", "resources", "revision-request.schema.json");
  const schemaRaw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw);
  const validate = ajv.compile(schema);

  if (!validate(revisionRequest)) {
    const msg = (validate.errors as any[])?.map((e: any) => `${e.instancePath} ${e.message}`).join(", ");
    throw new WebReviewError("WEB_REVIEW_REVISION_REQUEST_INVALID", `Generated revision request schema validation failed: ${msg}`);
  }

  const canonicalBuffer = canonicalJsonBuffer(revisionRequest);
  const revisionRequestSha256 = sha256Hex(canonicalBuffer);

  return {
    revisionRequest,
    canonicalBuffer,
    revisionRequestSha256,
  };
}
