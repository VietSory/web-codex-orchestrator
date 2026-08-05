import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt } from "./contracts.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Mod from "ajv/dist/2020.js";

// ajv/dist/2020.js may use CJS default export
const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Criterion result per schema 1.1 */
export interface VerdictCriterionResult {
  criterion_id: string;
  status: "PASS" | "FAIL" | "NOT_APPLICABLE" | "UNVERIFIED";
  reviewer_comments: string;
  evidence_refs: string[];
}

/** Web review verdict per schema 1.1 */
export interface WebReviewVerdict {
  schema_version: "1.1";
  verdict: "APPROVE" | "REVISE" | "ESCALATE";
  review_mode: "INITIAL" | "REVISION";
  review_round: number;
  run_id: string;
  spec_set_sha256: string;
  result_bundle_sha256: string;
  manifest_sha256: string;
  reviewed_entry_set_sha256: string;
  published_commit_sha: string;
  pull_request_number: number;
  observed_head_sha: string;
  review_contract_version: string;
  review_policy_version: string;
  previous_result_bundle_sha256: string | null;
  previous_verdict_sha256: string | null;
  revision_request_sha256: string | null;
  previous_published_commit_sha: string | null;
  comprehensive_review_complete: boolean;
  criterion_results: VerdictCriterionResult[];
  blocking_findings: string[];
  non_blocking_backlog: string[];
  summary: string;
}

/**
 * Validate a web review verdict against:
 * 1. The embedded JSON schema (schema 1.1)
 * 2. Binding hash comparisons against the sealed receipt
 * 3. Criterion set equality against locked acceptance.json IDs
 *
 * Throws ResultBundleError("RESULT_WEB_VERDICT_INVALID", ...) on any violation.
 */
export function validateWebVerdict(
  verdictData: unknown,
  acceptanceData: unknown,
  receipt: ResultBundleReceipt
): void {
  // 1. JSON Schema validation against embedded schema 1.1 (JSON Schema draft 2020-12)
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemaPath = path.join(__dirname, "resources", "web-review-verdict.schema.json");
  const schemaRaw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw);
  const validate = ajv.compile(schema);

  if (!validate(verdictData)) {
    const msg = (validate.errors as any[])?.map((e: any) => `${e.instancePath} ${e.message}`).join(", ");
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Verdict schema validation failed: ${msg}`);
  }

  const verdict = verdictData as WebReviewVerdict;

  // 2. Binding hash comparisons
  if (verdict.run_id !== receipt.run_id) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `run_id mismatch. Expected ${receipt.run_id}, got ${verdict.run_id}`
    );
  }
  if (verdict.result_bundle_sha256 !== receipt.archive_sha256) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `result_bundle_sha256 mismatch. Expected ${receipt.archive_sha256}, got ${verdict.result_bundle_sha256}`
    );
  }
  if (verdict.manifest_sha256 !== receipt.manifest_sha256) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `manifest_sha256 mismatch. Expected ${receipt.manifest_sha256}, got ${verdict.manifest_sha256}`
    );
  }
  if (verdict.spec_set_sha256 !== receipt.spec_set_sha256) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `spec_set_sha256 mismatch. Expected ${receipt.spec_set_sha256}, got ${verdict.spec_set_sha256}`
    );
  }
  if (verdict.pull_request_number !== receipt.pull_request?.number) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `pull_request_number mismatch. Expected ${receipt.pull_request?.number}, got ${verdict.pull_request_number}`
    );
  }

  // 3. Criterion set equality vs locked acceptance.json IDs
  const acceptance = acceptanceData as { criteria?: { id: string }[] };
  const lockedIds = new Set<string>();
  if (Array.isArray(acceptance.criteria)) {
    for (const c of acceptance.criteria) {
      if (c.id) lockedIds.add(c.id);
    }
  }

  const providedIds = new Set<string>();
  for (const c of verdict.criterion_results) {
    if (providedIds.has(c.criterion_id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Duplicate criterion_id: ${c.criterion_id}`);
    }
    providedIds.add(c.criterion_id);

    if (!lockedIds.has(c.criterion_id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Unknown criterion_id: ${c.criterion_id}`);
    }

    // Evidence reference prefix validation
    for (const ref of c.evidence_refs) {
      if (!ref.startsWith("evidence/") && !ref.startsWith("repository/") && !ref.startsWith("task/")) {
        throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Invalid evidence reference prefix: ${ref}`);
      }
    }
  }

  for (const id of lockedIds) {
    if (!providedIds.has(id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Missing criterion_result for locked ID: ${id}`);
    }
  }
}
