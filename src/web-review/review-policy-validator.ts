// Verdict schema, mandatory binding, locked reference registry, and anti-drip policy validator for Phase 7
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Ajv2020Mod from "ajv/dist/2020.js";
import { WebReviewError } from "./contracts.js";
import type { WebReviewVerdict, VerdictBlockingFinding } from "./contracts.js";
import type { LoadedResultBundle } from "./result-bundle-review-reader.js";

const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ESCALATION_ONLY_CLASSIFICATIONS = new Set<string>([
  "CRITICAL_SECURITY_EXCEPTION",
  "ARTIFACT_UNTRUSTED",
  "REVISION_BUDGET_EXHAUSTED",
]);

export const FIXABLE_CLASSIFICATIONS = new Set<string>([
  "SPEC_VIOLATION",
  "IMPLEMENTATION_DEFECT",
  "EVIDENCE_GAP",
  "REPOSITORY_DRIFT",
  "SPEC_CONTRADICTION",
  "HUMAN_REQUIRED",
]);

/** Compute changed file paths between two published commits using safe argv git diff-tree */
export function computeGitDiffDelta(
  repoDir: string,
  prevCommit: string,
  currCommit: string
): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (!prevCommit || !currCommit || prevCommit === currCommit) {
      return resolve(new Set());
    }
    const proc = spawn("git", ["diff-tree", "-r", "--name-only", prevCommit, currCommit], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(new Set());
      const text = Buffer.concat(chunks).toString("utf8");
      const files = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      resolve(new Set(files));
    });
    proc.on("error", () => resolve(new Set()));
  });
}

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
  repoDir?: string
): Promise<WebReviewVerdict> {
  // 1. JSON Schema validation using embedded schema 1.1
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

  // 2. Validate round matches verdict review_round
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

  // 6. Verdict Semantics & Classification rules
  if (verdict.verdict === "APPROVE") {
    if (!verdict.comprehensive_review_complete) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "APPROVE verdict requires comprehensive_review_complete to be true.");
    }
    if (verdict.blocking_findings.length > 0) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "APPROVE verdict cannot contain blocking findings.");
    }
    for (const c of verdict.criterion_results) {
      if (c.status !== "PASS") {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", `APPROVE verdict requires all criteria to be PASS (found '${c.criterion_id}' = '${c.status}').`);
      }
    }
  } else if (verdict.verdict === "REVISE") {
    if (reviewRound >= 4) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "REVISE verdict is invalid at round 4 (exceeds maximum 3 revision budget). Use ESCALATE.");
    }
    if (verdict.blocking_findings.length === 0) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "REVISE verdict requires at least one fixable blocking finding.");
    }
    for (const finding of verdict.blocking_findings) {
      if (ESCALATION_ONLY_CLASSIFICATIONS.has(finding.classification)) {
        throw new WebReviewError(
          "WEB_REVIEW_VERDICT_INVALID",
          `REVISE verdict cannot contain escalation-only classification '${finding.classification}' (finding '${finding.finding_id}').`
        );
      }
    }
  } else if (verdict.verdict === "ESCALATE") {
    // Escalate is valid when there is at least one escalation-only classification, or at round 4 with unresolved findings
    if (reviewRound < 4) {
      const hasEscalationOnly = verdict.blocking_findings.some((f) => ESCALATION_ONLY_CLASSIFICATIONS.has(f.classification));
      if (!hasEscalationOnly) {
        throw new WebReviewError("WEB_REVIEW_VERDICT_INVALID", "ESCALATE verdict prior to round 4 requires at least one escalation-only finding.");
      }
    }
  }

  // 7. Anti-Drip Policy Enforcement (rounds > 1)
  if (reviewRound > 1 && repoDir && verdict.previous_published_commit_sha) {
    const gitDelta = await computeGitDiffDelta(repoDir, verdict.previous_published_commit_sha, verdict.published_commit_sha);

    // Extract previous blocking finding IDs from previous revision request
    const previousFindingIds = new Set<string>();
    if (previousRevisionRequestData && typeof previousRevisionRequestData === "object" && Array.isArray((previousRevisionRequestData as any).findings)) {
      for (const pf of (previousRevisionRequestData as any).findings) {
        if (pf && typeof pf === "object" && pf.finding_id) previousFindingIds.add(pf.finding_id);
      }
    }

    for (const finding of verdict.blocking_findings) {
      // Validate revision_changed_paths is a subset of gitDelta
      for (const changedPath of finding.revision_changed_paths) {
        if (gitDelta.size > 0 && !gitDelta.has(changedPath)) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' lists changed path '${changedPath}' which is not in computed git delta.`
          );
        }
      }

      // Origin-specific rules
      if (finding.finding_origin === "PREVIOUS_UNRESOLVED") {
        if (!finding.previous_finding_id || (previousFindingIds.size > 0 && !previousFindingIds.has(finding.previous_finding_id))) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' with origin PREVIOUS_UNRESOLVED has invalid previous_finding_id '${finding.previous_finding_id}'.`
          );
        }
      } else if (finding.finding_origin === "REVISION_REGRESSION" || finding.finding_origin === "REVISION_EVIDENCE_INVALIDATION") {
        if (finding.revision_changed_paths.length === 0) {
          throw new WebReviewError(
            "WEB_REVIEW_ANTI_DRIP_VIOLATION",
            `Finding '${finding.finding_id}' with origin '${finding.finding_origin}' must identify revision_changed_paths.`
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
    }
  }

  return verdict;
}
