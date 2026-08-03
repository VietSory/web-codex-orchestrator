type JsonSchema = Record<string, unknown>;

const boundedString = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const boundedStringArray = (maxItems: number, maxLength: number): JsonSchema => ({
  type: "array",
  maxItems,
  items: boundedString(maxLength),
});

const humanAction: JsonSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: ["credential", "network", "destructive", "production", "ambiguous_requirement", "paid_resource", "other"],
        },
        description: boundedString(16_384),
        requested_capability: boundedString(4_096),
      },
      required: ["category", "description", "requested_capability"],
    },
  ],
};

const bundleConflict: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: boundedString(256),
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    description: boundedString(16_384),
    affected_contract: boundedString(512),
  },
  required: ["id", "severity", "description", "affected_contract"],
};

const acceptanceEvidence: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    acceptance_id: boundedString(256),
    status: { type: "string", enum: ["implemented", "partially_implemented", "blocked"] },
    evidence: boundedStringArray(64, 4_096),
    notes: boundedString(16_384),
  },
  required: ["acceptance_id", "status", "evidence", "notes"],
};

const reviewFinding: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: boundedString(256),
    severity: { type: "string", enum: ["medium", "high", "critical"] },
    category: { type: "string", enum: ["correctness", "security", "regression", "scope", "tests", "maintainability", "performance"] },
    file: boundedString(512),
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    acceptance_ids: boundedStringArray(64, 256),
    problem: boundedString(16_384),
    evidence: boundedString(16_384),
    required_fix: boundedString(16_384),
  },
  required: ["id", "severity", "category", "file", "line_start", "line_end", "acceptance_ids", "problem", "evidence", "required_fix"],
};

const acceptanceResult: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    acceptance_id: boundedString(256),
    status: { type: "string", enum: ["PASS", "FAIL", "UNVERIFIED"] },
    evidence: boundedStringArray(64, 4_096),
  },
  required: ["acceptance_id", "status", "evidence"],
};

export const ASSESSMENT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["COMPATIBLE", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "BLOCKED"] },
    summary: boundedString(16_384),
    repository_observations: boundedStringArray(256, 4_096),
    bundle_conflicts: { type: "array", maxItems: 256, items: bundleConflict },
    missing_prerequisites: boundedStringArray(256, 4_096),
    human_action: humanAction,
  },
  required: ["status", "summary", "repository_observations", "bundle_conflicts", "missing_prerequisites", "human_action"],
};

export const IMPLEMENTATION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["READY_FOR_VERIFICATION", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "BLOCKED"] },
    summary: boundedString(16_384),
    changed_files_claimed: boundedStringArray(256, 512),
    acceptance_evidence: { type: "array", maxItems: 256, items: acceptanceEvidence },
    tests_added_or_changed: boundedStringArray(256, 512),
    unresolved_issues: boundedStringArray(256, 4_096),
    human_action: humanAction,
  },
  required: ["status", "summary", "changed_files_claimed", "acceptance_evidence", "tests_added_or_changed", "unresolved_issues", "human_action"],
};

export const REVIEW_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REVISE", "REPLAN", "ESCALATE"] },
    reviewed_change_set_sha256: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 },
    summary: boundedString(16_384),
    acceptance_results: { type: "array", maxItems: 512, items: acceptanceResult },
    blocking_findings: { type: "array", maxItems: 256, items: reviewFinding },
    non_blocking_findings: { type: "array", maxItems: 256, items: reviewFinding },
    scope_violations: boundedStringArray(256, 4_096),
    unverified_acceptance: boundedStringArray(256, 4_096),
    human_action: humanAction,
  },
  required: ["verdict", "reviewed_change_set_sha256", "summary", "acceptance_results", "blocking_findings", "non_blocking_findings", "scope_violations", "unverified_acceptance", "human_action"],
};
