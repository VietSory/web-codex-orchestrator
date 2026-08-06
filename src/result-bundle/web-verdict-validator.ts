import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt, ResultBundleManifest } from "./contracts.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Mod from "ajv/dist/2020.js";

// ajv/dist/2020.js may use CJS default export
const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Non-blocking backlog item per schema 1.1 */
export interface VerdictBacklogItem {
  id: string;
  description: string;
}

/** Criterion result per schema 1.1 */
export interface VerdictCriterionResult {
  criterion_id: string;
  required: true;
  status: "PASS" | "FAIL" | "UNVERIFIED";
  evidence_refs: string[];
  notes: string;
}

/** Blocking finding per schema 1.1 */
export interface VerdictBlockingFinding {
  finding_id: string;
  classification:
    | "SPEC_VIOLATION"
    | "IMPLEMENTATION_DEFECT"
    | "EVIDENCE_GAP"
    | "REPOSITORY_DRIFT"
    | "SPEC_CONTRADICTION"
    | "HUMAN_REQUIRED"
    | "CRITICAL_SECURITY_EXCEPTION"
    | "ARTIFACT_UNTRUSTED"
    | "REVISION_BUDGET_EXHAUSTED";
  finding_origin:
    | "INITIAL_DISCOVERY"
    | "PREVIOUS_UNRESOLVED"
    | "REVISION_REGRESSION"
    | "REVISION_EVIDENCE_INVALIDATION"
    | "UNCHANGED_CRITICAL_EXCEPTION"
    | "SYSTEM_EXCEPTION";
  previous_finding_id: string | null;
  locked_reference_ids: string[];
  artifact_paths: string[];
  line_or_json_pointer: string;
  expected_behavior: string;
  observed_behavior: string;
  evidence: string;
  minimal_required_fix: string;
  revision_changed_paths: string[];
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
  review_contract_version: "1.1";
  review_policy_version: "1.0";
  previous_result_bundle_sha256: string | null;
  previous_verdict_sha256: string | null;
  revision_request_sha256: string | null;
  previous_published_commit_sha: string | null;
  comprehensive_review_complete: boolean;
  criterion_results: VerdictCriterionResult[];
  blocking_findings: VerdictBlockingFinding[];
  non_blocking_backlog: VerdictBacklogItem[];
  summary: string;
}

/**
 * Validate a web review verdict against:
 * 1. The embedded JSON schema (schema 1.1)
 * 2. Mandatory receipt binding comparisons (run_id, result_bundle_sha256,
 *    manifest_sha256, spec_set_sha256, pull_request_number, published_commit_sha,
 *    observed_head_sha, reviewed_entry_set_sha256)
 * 3. Criterion set equality against locked acceptance.json IDs
 * 4. Mandatory exact evidence-entry existence verification against bundle entries
 *
 * Throws ResultBundleError("RESULT_WEB_VERDICT_INVALID", ...) on any violation.
 */
export function validateWebVerdict(
  verdictData: unknown,
  acceptanceData: unknown,
  receipt: ResultBundleReceipt,
  bundleEntries: Set<string> | string[] | ResultBundleManifest
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

  // 2. Mandatory receipt binding validations
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
  if (verdict.published_commit_sha !== receipt.published_commit_sha) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `published_commit_sha mismatch. Expected ${receipt.published_commit_sha}, got ${verdict.published_commit_sha}`
    );
  }
  if (verdict.observed_head_sha !== receipt.pull_request?.head_sha) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `observed_head_sha mismatch. Expected ${receipt.pull_request?.head_sha}, got ${verdict.observed_head_sha}`
    );
  }
  if (verdict.reviewed_entry_set_sha256 !== receipt.reviewed_entry_set_sha256) {
    throw new ResultBundleError(
      "RESULT_WEB_VERDICT_INVALID",
      `reviewed_entry_set_sha256 mismatch. Expected ${receipt.reviewed_entry_set_sha256}, got ${verdict.reviewed_entry_set_sha256}`
    );
  }

  // 3. Construct exact entry set unconditionally (bundleEntries is mandatory)
  let entrySet: Set<string>;
  if (bundleEntries instanceof Set) {
    entrySet = bundleEntries;
  } else if (Array.isArray(bundleEntries)) {
    entrySet = new Set(bundleEntries);
  } else if (bundleEntries && typeof bundleEntries === "object" && Array.isArray((bundleEntries as ResultBundleManifest).entries)) {
    entrySet = new Set((bundleEntries as ResultBundleManifest).entries.map((e) => e.path));
    entrySet.add("manifest.json");
  } else {
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", "Invalid or missing bundleEntries parameter.");
  }

  // 4. Criterion set equality & evidence entry existence
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

    if (lockedIds.size > 0 && !lockedIds.has(c.criterion_id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Unknown criterion_id: ${c.criterion_id}`);
    }

    // Evidence reference prefix validation & exact entry existence
    for (const ref of c.evidence_refs) {
      if (
        !ref.startsWith("evidence/") &&
        !ref.startsWith("repository/") &&
        !ref.startsWith("task/") &&
        !ref.startsWith("review/") &&
        ref !== "RESULT.md" &&
        ref !== "REVIEW.md" &&
        ref !== "checksums.json" &&
        ref !== "manifest.json"
      ) {
        throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Invalid evidence reference prefix: ${ref}`);
      }
      if (!entrySet.has(ref)) {
        throw new ResultBundleError(
          "RESULT_WEB_VERDICT_INVALID",
          `Evidence reference not found in bundle entries: '${ref}'`
        );
      }
    }
  }

  for (const id of lockedIds) {
    if (!providedIds.has(id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Missing criterion_result for locked ID: ${id}`);
    }
  }

  // Exact entry existence check for blocking findings artifact_paths
  if (Array.isArray(verdict.blocking_findings)) {
    for (const finding of verdict.blocking_findings) {
      if (Array.isArray(finding.artifact_paths)) {
        for (const artPath of finding.artifact_paths) {
          if (!entrySet.has(artPath)) {
            throw new ResultBundleError(
              "RESULT_WEB_VERDICT_INVALID",
              `Artifact path in finding not found in bundle entries: '${artPath}'`
            );
          }
        }
      }
    }
  }
}
