import { scoreSemanticUnderstanding, type SemanticUnderstandingCandidate, type SemanticUnderstandingGold, type SemanticUnderstandingScore } from "./semantic-understanding.js";

export type SemanticEvidenceCategory = "component" | "invariant" | "risk" | "unknown" | "assumption";

export interface SemanticEvidenceItem {
  id: string;
  category: SemanticEvidenceCategory;
  text: string;
}

export interface SemanticBenchmarkCase {
  case_id: string;
  category: string;
  goal: string;
  evidence_catalog: SemanticEvidenceItem[];
  gold: SemanticUnderstandingGold;
}

export interface SemanticBenchmarkCorpus {
  schema_version: "1.0";
  cases: SemanticBenchmarkCase[];
}

export interface PublicSemanticBenchmarkCase {
  case_id: string;
  category: string;
  goal: string;
  evidence_catalog: SemanticEvidenceItem[];
}

export interface SemanticCorpusReport {
  schema_version: "1.0";
  kind: "semantic-understanding-corpus";
  cases: number;
  perfect_cases: number;
  cases_with_critical_miss: number;
  weighted_quality_mean: number;
  critical_recall_mean: number;
  unnecessary_selection_rate_mean: number;
  samples: Array<{ case_id: string; score: SemanticUnderstandingScore }>;
}

const CATEGORY_BY_GOLD_FIELD: Array<{ field: keyof Omit<SemanticUnderstandingGold, "critical_ids">; category: SemanticEvidenceCategory }> = [
  { field: "required_component_ids", category: "component" },
  { field: "required_invariant_ids", category: "invariant" },
  { field: "required_risk_ids", category: "risk" },
  { field: "required_unknown_ids", category: "unknown" },
  { field: "rejected_assumption_ids", category: "assumption" },
];

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unexpected field '${extras[0]}'.`);
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${label} must be a ${minimum}-${maximum} character string.`);
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, 2, 64));
}

function parseGold(value: unknown, label: string): SemanticUnderstandingGold {
  const object = objectValue(value, label);
  const allowed = ["required_component_ids", "required_invariant_ids", "required_risk_ids", "required_unknown_ids", "rejected_assumption_ids", "critical_ids"] as const;
  exactKeys(object, allowed, label);
  return {
    required_component_ids: parseStringArray(object.required_component_ids, `${label}.required_component_ids`),
    required_invariant_ids: parseStringArray(object.required_invariant_ids, `${label}.required_invariant_ids`),
    required_risk_ids: parseStringArray(object.required_risk_ids, `${label}.required_risk_ids`),
    required_unknown_ids: parseStringArray(object.required_unknown_ids, `${label}.required_unknown_ids`),
    rejected_assumption_ids: parseStringArray(object.rejected_assumption_ids, `${label}.rejected_assumption_ids`),
    critical_ids: parseStringArray(object.critical_ids, `${label}.critical_ids`),
  };
}

function parseEvidence(value: unknown, label: string): SemanticEvidenceItem {
  const object = objectValue(value, label);
  exactKeys(object, ["id", "category", "text"], label);
  const id = boundedString(object.id, `${label}.id`, 2, 64);
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(id)) throw new Error(`${label}.id is not a valid semantic ID.`);
  const category = object.category;
  if (!(["component", "invariant", "risk", "unknown", "assumption"] as const).includes(category as SemanticEvidenceCategory)) throw new Error(`${label}.category is invalid.`);
  return { id, category: category as SemanticEvidenceCategory, text: boundedString(object.text, `${label}.text`, 8, 4096) };
}

function validateCaseTruth(item: SemanticBenchmarkCase): void {
  const catalog = new Map<string, SemanticEvidenceItem>();
  for (const evidence of item.evidence_catalog) {
    if (catalog.has(evidence.id)) throw new Error(`Case ${item.case_id} contains duplicate evidence ID '${evidence.id}'.`);
    catalog.set(evidence.id, evidence);
  }

  const required = new Set<string>();
  for (const mapping of CATEGORY_BY_GOLD_FIELD) {
    for (const id of item.gold[mapping.field]) {
      if (required.has(id)) throw new Error(`Case ${item.case_id} gold ID '${id}' appears in multiple semantic categories.`);
      required.add(id);
      const evidence = catalog.get(id);
      if (!evidence) throw new Error(`Case ${item.case_id} gold ID '${id}' is missing from the evidence catalog.`);
      if (evidence.category !== mapping.category) throw new Error(`Case ${item.case_id} gold ID '${id}' is catalogued as ${evidence.category}, expected ${mapping.category}.`);
    }
  }
  for (const id of item.gold.critical_ids) {
    if (!required.has(id)) throw new Error(`Case ${item.case_id} critical ID '${id}' is not required gold truth.`);
  }
  if (item.gold.critical_ids.length === 0) throw new Error(`Case ${item.case_id} must define at least one critical semantic item.`);
  if (![...catalog.keys()].some((id) => !required.has(id))) throw new Error(`Case ${item.case_id} has no distractor evidence; the benchmark would be trivial.`);
}

export function parseSemanticBenchmarkCorpus(value: unknown): SemanticBenchmarkCorpus {
  const object = objectValue(value, "semantic benchmark corpus");
  exactKeys(object, ["schema_version", "cases"], "semantic benchmark corpus");
  if (object.schema_version !== "1.0") throw new Error("Semantic benchmark corpus schema_version must be 1.0.");
  if (!Array.isArray(object.cases) || object.cases.length < 1 || object.cases.length > 128) throw new Error("Semantic benchmark corpus must contain 1-128 cases.");
  const seen = new Set<string>();
  const cases = object.cases.map((raw, index): SemanticBenchmarkCase => {
    const item = objectValue(raw, `cases[${index}]`);
    exactKeys(item, ["case_id", "category", "goal", "evidence_catalog", "gold"], `cases[${index}]`);
    const caseId = boundedString(item.case_id, `cases[${index}].case_id`, 3, 64);
    if (!/^[A-Z][A-Z0-9_-]{2,63}$/.test(caseId)) throw new Error(`cases[${index}].case_id is invalid.`);
    if (seen.has(caseId)) throw new Error(`Duplicate semantic benchmark case '${caseId}'.`);
    seen.add(caseId);
    if (!Array.isArray(item.evidence_catalog) || item.evidence_catalog.length < 5 || item.evidence_catalog.length > 128) throw new Error(`Case ${caseId} evidence_catalog must contain 5-128 items.`);
    const parsed: SemanticBenchmarkCase = {
      case_id: caseId,
      category: boundedString(item.category, `Case ${caseId}.category`, 3, 64),
      goal: boundedString(item.goal, `Case ${caseId}.goal`, 12, 4096),
      evidence_catalog: item.evidence_catalog.map((entry, evidenceIndex) => parseEvidence(entry, `Case ${caseId}.evidence_catalog[${evidenceIndex}]`)),
      gold: parseGold(item.gold, `Case ${caseId}.gold`),
    };
    validateCaseTruth(parsed);
    return parsed;
  });
  return { schema_version: "1.0", cases };
}

export function publicSemanticBenchmarkCase(item: SemanticBenchmarkCase): PublicSemanticBenchmarkCase {
  return {
    case_id: item.case_id,
    category: item.category,
    goal: item.goal,
    evidence_catalog: item.evidence_catalog.map((entry) => ({ ...entry })),
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot summarize an empty semantic benchmark.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export function scoreSemanticCorpus(corpus: SemanticBenchmarkCorpus, candidates: ReadonlyMap<string, SemanticUnderstandingCandidate>): SemanticCorpusReport {
  const samples = corpus.cases.map((item) => {
    const candidate = candidates.get(item.case_id);
    if (!candidate) throw new Error(`Missing semantic benchmark candidate for case '${item.case_id}'.`);
    return { case_id: item.case_id, score: scoreSemanticUnderstanding(candidate, item.gold) };
  });
  if (candidates.size !== corpus.cases.length) throw new Error("Semantic benchmark candidate set contains missing or extra case identities.");
  return {
    schema_version: "1.0",
    kind: "semantic-understanding-corpus",
    cases: samples.length,
    perfect_cases: samples.filter((sample) => sample.score.weighted_quality === 1 && sample.score.critical_misses.length === 0).length,
    cases_with_critical_miss: samples.filter((sample) => sample.score.critical_misses.length > 0).length,
    weighted_quality_mean: rounded(mean(samples.map((sample) => sample.score.weighted_quality))),
    critical_recall_mean: rounded(mean(samples.map((sample) => sample.score.critical_recall))),
    unnecessary_selection_rate_mean: rounded(mean(samples.map((sample) => sample.score.unnecessary_selection_rate))),
    samples,
  };
}
