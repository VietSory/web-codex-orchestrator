import {
  publicSemanticBenchmarkCase,
  scoreSemanticCorpus,
  type PublicSemanticBenchmarkCase,
  type SemanticBenchmarkCorpus,
  type SemanticCorpusReport,
} from "./semantic-corpus.js";
import type { SemanticUnderstandingCandidate } from "./semantic-understanding.js";

export interface SemanticBenchmarkSelection {
  schema_version: "1.0";
  kind: "semantic-benchmark-selection";
  case_id: string;
  selected_ids: string[];
}

export interface SemanticBenchmarkArmResult {
  schema_version: "1.0";
  kind: "semantic-benchmark-arm";
  arm: string;
  provider_turns: number;
  report: SemanticCorpusReport;
}

export interface SemanticBenchmarkComparison {
  schema_version: "1.0";
  kind: "semantic-benchmark-comparison";
  baseline_arm: string;
  challenger_arm: string;
  weighted_quality_delta: number;
  critical_recall_delta: number;
  critical_miss_case_delta: number;
  unnecessary_selection_rate_delta: number;
  challenger_better_cases: string[];
  challenger_worse_cases: string[];
  mixed_cases: string[];
  unchanged_cases: string[];
}

export type SemanticBenchmarkProvider = (options: {
  case_id: string;
  prompt: string;
  public_case: PublicSemanticBenchmarkCase;
}) => Promise<unknown>;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Role-neutral prompt for one benchmark semantic-selection turn.
 *
 * Hidden gold is intentionally absent. The provider sees only the same public
 * case goal and evidence catalog available to any evaluated arm. The caller
 * supplies the arm-specific author/challenger policy separately so the common
 * prompt cannot bias one arm toward the other's role.
 */
export function semanticBenchmarkSelectionPrompt(item: PublicSemanticBenchmarkCase): string {
  return [
    "WCO_SEMANTIC_BENCHMARK:SELECTION",
    "Follow the benchmark role/policy supplied before this common instruction.",
    "Select only the evidence IDs that are materially required to understand the goal safely.",
    "Include relevant components, invariants, risks, unresolved unknowns, and assumptions that must be rejected.",
    "Do not select an item merely because it is present. Challenge distractors and unsupported assumptions as required by your assigned role.",
    "Return exactly one JSON object: {\"schema_version\":\"1.0\",\"kind\":\"semantic-benchmark-selection\",\"case_id\":<case id>,\"selected_ids\":[...]}.",
    `Public benchmark case: ${JSON.stringify(item)}`,
  ].join("\n");
}

export function parseSemanticBenchmarkSelection(value: unknown, item: PublicSemanticBenchmarkCase): SemanticBenchmarkSelection {
  const record = objectValue(value, "semantic benchmark selection");
  const fields = ["schema_version", "kind", "case_id", "selected_ids"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) throw new Error("semantic benchmark selection fields are invalid.");
  if (record.schema_version !== "1.0" || record.kind !== "semantic-benchmark-selection" || record.case_id !== item.case_id) throw new Error("semantic benchmark selection identity is invalid.");
  if (!Array.isArray(record.selected_ids)) throw new Error("semantic benchmark selection selected_ids must be an array.");
  if (record.selected_ids.length > item.evidence_catalog.length) throw new Error("semantic benchmark selection exceeds the public evidence catalog bound.");
  const publicIds = new Set(item.evidence_catalog.map((entry) => entry.id));
  const seen = new Set<string>();
  const selected = record.selected_ids.map((raw, index) => {
    if (typeof raw !== "string" || !/^[A-Z][A-Z0-9_-]{1,63}$/.test(raw)) throw new Error(`semantic benchmark selection id ${index} is invalid.`);
    if (!publicIds.has(raw)) throw new Error(`semantic benchmark selection references non-public evidence '${raw}'.`);
    if (seen.has(raw)) throw new Error(`semantic benchmark selection duplicates evidence '${raw}'.`);
    seen.add(raw);
    return raw;
  });
  return { schema_version: "1.0", kind: "semantic-benchmark-selection", case_id: item.case_id, selected_ids: selected };
}

export function semanticCandidateFromSelection(item: PublicSemanticBenchmarkCase, selection: SemanticBenchmarkSelection): SemanticUnderstandingCandidate {
  const parsed = parseSemanticBenchmarkSelection(selection, item);
  const selected = new Set(parsed.selected_ids);
  const ids = (category: string) => item.evidence_catalog.filter((entry) => entry.category === category && selected.has(entry.id)).map((entry) => entry.id);
  return {
    affected_component_ids: ids("component"),
    invariant_ids: ids("invariant"),
    risk_ids: ids("risk"),
    unknown_ids: ids("unknown"),
    rejected_assumption_ids: ids("assumption"),
  };
}

export async function evaluateSemanticBenchmarkArm(options: {
  arm: string;
  corpus: SemanticBenchmarkCorpus;
  provider: SemanticBenchmarkProvider;
}): Promise<SemanticBenchmarkArmResult> {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(options.arm)) throw new Error("semantic benchmark arm identity is invalid.");
  const candidates = new Map<string, SemanticUnderstandingCandidate>();
  let providerTurns = 0;
  for (const benchmarkCase of options.corpus.cases) {
    const publicCase = publicSemanticBenchmarkCase(benchmarkCase);
    const output = await options.provider({
      case_id: benchmarkCase.case_id,
      prompt: semanticBenchmarkSelectionPrompt(publicCase),
      public_case: publicCase,
    });
    providerTurns += 1;
    const selection = parseSemanticBenchmarkSelection(output, publicCase);
    candidates.set(benchmarkCase.case_id, semanticCandidateFromSelection(publicCase, selection));
  }
  return {
    schema_version: "1.0",
    kind: "semantic-benchmark-arm",
    arm: options.arm,
    provider_turns: providerTurns,
    report: scoreSemanticCorpus(options.corpus, candidates),
  };
}

export function compareSemanticBenchmarkArms(baseline: SemanticBenchmarkArmResult, challenger: SemanticBenchmarkArmResult): SemanticBenchmarkComparison {
  if (baseline.report.cases !== challenger.report.cases) throw new Error("semantic benchmark arms contain different case counts.");
  const baselineByCase = new Map(baseline.report.samples.map((sample) => [sample.case_id, sample.score]));
  const challengerByCase = new Map(challenger.report.samples.map((sample) => [sample.case_id, sample.score]));
  if (baselineByCase.size !== challengerByCase.size || [...baselineByCase.keys()].some((id) => !challengerByCase.has(id))) throw new Error("semantic benchmark arms contain different case identities.");
  const better: string[] = [];
  const worse: string[] = [];
  const mixed: string[] = [];
  const unchanged: string[] = [];
  for (const [caseId, base] of baselineByCase) {
    const next = challengerByCase.get(caseId)!;
    const qualityBetterOrEqual = next.weighted_quality >= base.weighted_quality;
    const criticalBetterOrEqual = next.critical_recall >= base.critical_recall;
    const selectionBetterOrEqual = next.unnecessary_selection_rate <= base.unnecessary_selection_rate;
    const qualityWorseOrEqual = next.weighted_quality <= base.weighted_quality;
    const criticalWorseOrEqual = next.critical_recall <= base.critical_recall;
    const selectionWorseOrEqual = next.unnecessary_selection_rate >= base.unnecessary_selection_rate;
    const anyImprovement = next.weighted_quality > base.weighted_quality
      || next.critical_recall > base.critical_recall
      || next.unnecessary_selection_rate < base.unnecessary_selection_rate;
    const anyRegression = next.weighted_quality < base.weighted_quality
      || next.critical_recall < base.critical_recall
      || next.unnecessary_selection_rate > base.unnecessary_selection_rate;

    if (qualityBetterOrEqual && criticalBetterOrEqual && selectionBetterOrEqual && anyImprovement) better.push(caseId);
    else if (qualityWorseOrEqual && criticalWorseOrEqual && selectionWorseOrEqual && anyRegression) worse.push(caseId);
    else if (anyImprovement && anyRegression) mixed.push(caseId);
    else unchanged.push(caseId);
  }
  return {
    schema_version: "1.0",
    kind: "semantic-benchmark-comparison",
    baseline_arm: baseline.arm,
    challenger_arm: challenger.arm,
    weighted_quality_delta: rounded(challenger.report.weighted_quality_mean - baseline.report.weighted_quality_mean),
    critical_recall_delta: rounded(challenger.report.critical_recall_mean - baseline.report.critical_recall_mean),
    critical_miss_case_delta: challenger.report.cases_with_critical_miss - baseline.report.cases_with_critical_miss,
    unnecessary_selection_rate_delta: rounded(challenger.report.unnecessary_selection_rate_mean - baseline.report.unnecessary_selection_rate_mean),
    challenger_better_cases: better,
    challenger_worse_cases: worse,
    mixed_cases: mixed,
    unchanged_cases: unchanged,
  };
}
