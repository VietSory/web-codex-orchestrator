import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt } from "./contracts.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface VerdictCriterionResult {
  criterion_id: string;
  status: "pass" | "fail" | "not_applicable" | "unverified";
  reviewer_comments?: string;
  evidence_references?: string[];
}

export interface WebReviewVerdict {
  schema_version: "1.0";
  verdict: "accept" | "reject" | "revise";
  reviewer_identity: string;
  run_id: string;
  bundle_archive_sha256: string;
  spec_set_sha256: string;
  criterion_results: VerdictCriterionResult[];
  overall_comments?: string;
}

export function validateWebVerdict(
  verdictData: unknown,
  acceptanceData: unknown,
  receipt: ResultBundleReceipt
): void {
  // 1. Schema validation
  const ajv = new Ajv({ strict: true, allErrors: true });
  const schemaPath = path.join(__dirname, "resources", "web-review-verdict.schema.json");
  const schemaRaw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw);
  const validate = ajv.compile(schema);
  
  if (!validate(verdictData)) {
    const msg = (validate.errors as any[])?.map((e: any) => `${e.instancePath} ${e.message}`).join(", ");
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Verdict schema validation failed: ${msg}`);
  }

  const verdict = verdictData as WebReviewVerdict;

  // 2. Binding hash comparison
  if (verdict.run_id !== receipt.run_id) {
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `run_id mismatch. Expected ${receipt.run_id}, got ${verdict.run_id}`);
  }
  if (verdict.bundle_archive_sha256 !== receipt.archive_sha256) {
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `bundle_archive_sha256 mismatch. Expected ${receipt.archive_sha256}, got ${verdict.bundle_archive_sha256}`);
  }
  if (verdict.spec_set_sha256 !== receipt.spec_set_sha256) {
    throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `spec_set_sha256 mismatch. Expected ${receipt.spec_set_sha256}, got ${verdict.spec_set_sha256}`);
  }

  // 3. Exact set equality for criterion results vs locked acceptance.json IDs
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

    // 4. Evidence reference resolution logic (just syntactic validation here)
    if (c.evidence_references) {
      for (const ref of c.evidence_references) {
        if (!ref.startsWith("evidence/") && !ref.startsWith("repository/") && !ref.startsWith("task/")) {
          throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Invalid evidence reference prefix: ${ref}`);
        }
      }
    }
  }

  for (const id of lockedIds) {
    if (!providedIds.has(id)) {
      throw new ResultBundleError("RESULT_WEB_VERDICT_INVALID", `Missing criterion_result for locked ID: ${id}`);
    }
  }
}
