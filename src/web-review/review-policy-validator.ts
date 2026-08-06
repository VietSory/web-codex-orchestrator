// Verdict schema, mandatory binding, locked reference registry, and anti-drip policy validator for Phase 7 (P0-06, P0-08)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Mod from "ajv/dist/2020.js";
import { WebReviewError } from "./contracts.js";
import type { WebReviewVerdict, VerdictBlockingFinding } from "./contracts.js";
import type { LoadedResultBundle } from "./result-bundle-review-reader.js";
import { computeBoundedGitDelta } from "./bounded-git-delta.js";

const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ESCALATION_ONLY_CLASSIFICATIONS = new Set<string>([
  "SPEC_CONTRADICTION",
  "HUMAN_REQUIRED",
  "CRITICAL_SECURITY_EXCEPTION",
  "ARTIFACT_UNTRUSTED",
  "REVISION_BUDGET_EXHAUSTED",
]);

export const FIXABLE_CLASSIFICATIONS = new Set<string>([
  "SPEC_VIOLATION",
  "IMPLEMENTATION_DEFECT",
  "EVIDENCE_GAP",
  "REPOSITORY_DRIFT",
]);

/** Re-export bounded Git delta calculation */
export const computeGitDiffDelta = computeBoundedGitDelta;

/** Build comprehensive locked reference registry from bundle task specs */
export function buildLockedReferenceRegistry(bundle: LoadedResultBundle): Set<string> {
  const registry = new Set<string>();

  // Acceptance criteria IDs
  const acceptance = bundle.acceptanceData as { criteria?: { id: string }[] };
  if (acceptance && Array.isArray(acceptance.criteria)) {
    for (const c of acceptance.criteria) {
      if (c.id) registry.add(c.id);
    }
  }

  // Test matrix case IDs
  const testMatrix = bundle.testMatrixData as { test_cases?: { id: string }[]; cases?: { id: string }[] };
  if (testMatrix) {
    const cases = testMatrix.test_cases ?? testMatrix.cases;
    if (Array.isArray(cases)) {
      for (const tc of cases) {
        if (tc.id) registry.add(tc.id);
      }
    }
  }

  // Validation command IDs
  const validation = bundle.validationData as { commands?: { id: string }[] };
  if (validation && Array.isArray(validation.commands)) {
    for (const cmd of validation.commands) {
      if (cmd.id) registry.add(cmd.id);
    }
  }

  // Common policy and invariant IDs
  registry.add("WEB-REVIEW-POLICY-1.0");
  registry.add("WEB-REVIEW-CONTRACT-1.1");
  registry.add("RESULT-BUNDLE-SCHEMA-1.1");

  return registry;
}

/** Validate web review verdict against schema, bindings, locked registry, and anti-drip policy */
export async function validateVerdictPolicy(
  verdictData: unknown,
  bundle: LoadedResultBundle,
  reviewRound: number,
  previousRevisionRequestData?: unknown,
  previousVerdictData?: unknown,
  repoDir?: string
): Promise<WebReviewVerdict> {
  // P0-02 check: Input verdict MUST NOT contain previous_pr_head_sha (schema 1.1 exact check)
  if (typeof verdictData === "object" && verdictData !== null && "previous_pr_head_sha" in verdictData) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_INVALID",
      "Verdict JSON schema validation failed: /previous_pr_head_sha is an additional property not allowed by schema 1.1."
    );
  }

  // 1. Schema validation against embedded web-review-verdict.schema.json
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemaPath = path.join(__dirname, "..", "result-bundle", "resources", "web-review-verdict.schema.json");
  const schemaRaw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw);
  const validate = ajv.compile(schema);

  if (!validate(verdictData)) {
    const msg = (validate.errors as any[])?.map((e: any) => `${e.instancePath} ${e.message}`).join(", ");
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `Verdict JSON schema validation failed: ${msg}`);
  }

  const verdict = verdictData as WebReviewVerdict;

  // 2. Validate round matching
  if (verdict.review_round !== reviewRound) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_INVALID",
      `Verdict review_round (${verdict.review_round}) does not match requested round (${reviewRound}).`
    );
  }

  // 3. Receipt binding comparisons
  const receipt = bundle.receipt;
  if (verdict.run_id !== receipt.run_id) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `run_id mismatch: got '${verdict.run_id}', expected '${receipt.run_id}'`);
  }
  if (verdict.spec_set_sha256 !== receipt.spec_set_sha256) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `spec_set_sha256 mismatch: got '${verdict.spec_set_sha256}', expected '${receipt.spec_set_sha256}'`);
  }
  if (verdict.result_bundle_sha256 !== receipt.archive_sha256) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `result_bundle_sha256 mismatch: got '${verdict.result_bundle_sha256}', expected '${receipt.archive_sha256}'`);
  }
  if (verdict.manifest_sha256 !== receipt.manifest_sha256) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `manifest_sha256 mismatch: got '${verdict.manifest_sha256}', expected '${receipt.manifest_sha256}'`);
  }
  if (verdict.reviewed_entry_set_sha256 !== receipt.reviewed_entry_set_sha256) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `reviewed_entry_set_sha256 mismatch: got '${verdict.reviewed_entry_set_sha256}', expected '${receipt.reviewed_entry_set_sha256}'`);
  }
  if (verdict.published_commit_sha !== receipt.published_commit_sha) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `published_commit_sha mismatch: got '${verdict.published_commit_sha}', expected '${receipt.published_commit_sha}'`);
  }
  if (verdict.pull_request_number !== receipt.pull_request.number) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `pull_request_number mismatch: got ${verdict.pull_request_number}, expected ${receipt.pull_request.number}`);
  }
  if (verdict.observed_head_sha !== receipt.pull_request.head_sha) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `observed_head_sha mismatch: got '${verdict.observed_head_sha}', expected '${receipt.pull_request.head_sha}'`);
  }

  // 4. Validate criterion ID set & evidence reference existence
  const acceptance = bundle.acceptanceData as { criteria?: { id: string }[] };
  const lockedCriterionIds = new Set<string>();
  if (acceptance && Array.isArray(acceptance.criteria)) {
    for (const c of acceptance.criteria) {
      if (c.id) lockedCriterionIds.add(c.id);
    }
  }

  const providedCriterionIds = new Set<string>();
  for (const c of verdict.criterion_results) {
    if (providedCriterionIds.has(c.criterion_id)) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `Duplicate criterion_id in verdict: '${c.criterion_id}'`);
    }
    providedCriterionIds.add(c.criterion_id);

    if (lockedCriterionIds.size > 0 && !lockedCriterionIds.has(c.criterion_id)) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `Unknown criterion_id in verdict: '${c.criterion_id}'`);
    }

    for (const ref of c.evidence_refs) {
      if (!bundle.bundleEntries.has(ref)) {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `Evidence reference not found in bundle archive: '${ref}'`);
      }
    }
  }

  for (const lockedId of lockedCriterionIds) {
    if (!providedCriterionIds.has(lockedId)) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `Missing criterion_result for locked criterion ID: '${lockedId}'`);
    }
  }

  // 5. Validate locked reference registry for findings & artifact existence
  const lockedRegistry = buildLockedReferenceRegistry(bundle);

  for (const finding of verdict.blocking_findings) {
    for (const refId of finding.locked_reference_ids) {
      if (!lockedRegistry.has(refId)) {
        throw new WebReviewError(
          "WEB_REVIEW_VERDICT_INVALID",
          `Finding '${finding.finding_id}' references unknown locked ID '${refId}' outside specification.`
        );
      }
    }
    for (const artPath of finding.artifact_paths) {
      if (!bundle.bundleEntries.has(artPath)) {
        throw new WebReviewError(
          "WEB_REVIEW_VERDICT_INVALID",
          `Finding '${finding.finding_id}' references artifact path '${artPath}' not in bundle.`
        );
      }
    }
  }

  // 6. Verdict Semantics & Classification rules (P0-06)
  if (verdict.verdict === "APPROVE") {
    if (!verdict.comprehensive_review_complete) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "APPROVE verdict requires comprehensive_review_complete: true.");
    }
    if (verdict.blocking_findings.length > 0) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "APPROVE verdict cannot contain blocking findings.");
    }
    for (const c of verdict.criterion_results) {
      if (c.status !== "PASS") {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `APPROVE verdict requires all criteria to be PASS, but '${c.criterion_id}' is '${c.status}'.`);
      }
    }
  } else if (verdict.verdict === "REVISE") {
    if (reviewRound >= 4) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "REVISE verdict is invalid at round 4 (revision budget exhausted; must be ESCALATE).");
    }
    let hasFixable = false;
    for (const f of verdict.blocking_findings) {
      if (ESCALATION_ONLY_CLASSIFICATIONS.has(f.classification)) {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `REVISE verdict cannot contain escalation-only classification '${f.classification}'.`);
      }
      if (FIXABLE_CLASSIFICATIONS.has(f.classification)) {
        hasFixable = true;
      }
    }
    if (!hasFixable) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "REVISE verdict requires at least one fixable blocking finding.");
    }
  } else if (verdict.verdict === "ESCALATE") {
    if (reviewRound < 4) {
      let hasEscalationOnly = false;
      for (const f of verdict.blocking_findings) {
        if (ESCALATION_ONLY_CLASSIFICATIONS.has(f.classification)) {
          hasEscalationOnly = true;
          break;
        }
      }
      if (!hasEscalationOnly) {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "ESCALATE verdict prior to round 4 requires at least one escalation-only finding.");
      }
    }
  }

  // 7. Anti-Drip Policy Enforcement (rounds > 1) (P0-08)
  if (reviewRound > 1) {
    if (!verdict.previous_published_commit_sha) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "Revision review verdict missing previous_published_commit_sha.");
    }

    let gitDelta = new Set<string>();
    if (repoDir) {
      gitDelta = await computeGitDiffDelta(repoDir, verdict.previous_published_commit_sha, verdict.published_commit_sha);
    }

    // Extract previous blocking finding IDs from previous revision request
    const previousFindingIds = new Set<string>();
    if (previousRevisionRequestData && typeof previousRevisionRequestData === "object" && Array.isArray((previousRevisionRequestData as any).findings)) {
      for (const pf of (previousRevisionRequestData as any).findings) {
        if (pf && typeof pf === "object" && pf.finding_id) previousFindingIds.add(pf.finding_id);
      }
    }

    // Extract previous criterion results map
    const prevPassCriteria = new Set<string>();
    if (previousVerdictData && typeof previousVerdictData === "object" && Array.isArray((previousVerdictData as any).criterion_results)) {
      for (const cr of (previousVerdictData as any).criterion_results) {
        if (cr && typeof cr === "object" && cr.criterion_id && cr.status === "PASS") {
          prevPassCriteria.add(cr.criterion_id);
        }
      }
    }

    for (const finding of verdict.blocking_findings) {
      // Rejection of INITIAL_DISCOVERY and SYSTEM_EXCEPTION in revision REVISE (P0-06)
      if (verdict.verdict === "REVISE" && (finding.finding_origin === "INITIAL_DISCOVERY" || finding.finding_origin === "SYSTEM_EXCEPTION")) {
        throw new WebReviewError(
          "WEB_REVIEW_ANTI_DRIP_VIOLATION",
          `Finding '${finding.finding_id}' with origin '${finding.finding_origin}' is forbidden in revision REVISE verdict.`
        );
      }

      // Validate revision_changed_paths is a subset of gitDelta (enforced even if gitDelta is empty) (P0-07)
      for (const changedPath of finding.revision_changed_paths) {
        const normalized = changedPath.replace(/^repository\/source\//, "");
        if (!gitDelta.has(normalized) && !gitDelta.has(changedPath)) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' lists changed path '${changedPath}' which is not in computed git delta.`
          );
        }
      }

      // Origin-specific rules & anti-drip path linking (P0-08)
      if (finding.finding_origin === "PREVIOUS_UNRESOLVED") {
        if (!finding.previous_finding_id) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' with origin PREVIOUS_UNRESOLVED missing mandatory previous_finding_id.`
          );
        }
        if (previousFindingIds.size > 0 && !previousFindingIds.has(finding.previous_finding_id)) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' references previous_finding_id '${finding.previous_finding_id}' which does not exist in previous revision request.`
          );
        }
        for (const refId of finding.locked_reference_ids) {
          if (prevPassCriteria.has(refId)) {
            throw new WebReviewError(
              "WEB_REVIEW_ANTI_DRIP_VIOLATION",
              `Finding '${finding.finding_id}' with origin PREVIOUS_UNRESOLVED cannot target criterion '${refId}' that was previously PASS.`
            );
          }
        }
      } else if (finding.finding_origin === "REVISION_REGRESSION" || finding.finding_origin === "REVISION_EVIDENCE_INVALIDATION") {
        if (finding.revision_changed_paths.length === 0) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' with origin '${finding.finding_origin}' must specify revision_changed_paths.`
          );
        }
      } else if (finding.finding_origin === "UNCHANGED_CRITICAL_EXCEPTION") {
        if (verdict.verdict !== "ESCALATE" || finding.classification !== "CRITICAL_SECURITY_EXCEPTION") {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Origin UNCHANGED_CRITICAL_EXCEPTION is allowed only with verdict ESCALATE and classification CRITICAL_SECURITY_EXCEPTION.`
          );
        }
      }

      // Anti-drip on previous PASS criteria: new blocker on previous PASS criterion requires valid regression/invalidation linked to delta
      for (const refId of finding.locked_reference_ids) {
        if (prevPassCriteria.has(refId)) {
          if (finding.finding_origin !== "REVISION_REGRESSION" && finding.finding_origin !== "REVISION_EVIDENCE_INVALIDATION" && finding.finding_origin !== "UNCHANGED_CRITICAL_EXCEPTION") {
            throw new WebReviewError(
              "WEB_REVIEW_ANTI_DRIP_VIOLATION",
              `Finding '${finding.finding_id}' introduces a new blocker on previous-PASS criterion '${refId}' without valid regression or invalidation origin.`
            );
          }
        }
      }
    }
  }

  return verdict;
}
