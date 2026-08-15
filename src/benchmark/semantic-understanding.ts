export interface SemanticUnderstandingGold {
  required_component_ids: string[];
  required_invariant_ids: string[];
  required_risk_ids: string[];
  required_unknown_ids: string[];
  rejected_assumption_ids: string[];
  critical_ids: string[];
}

export interface SemanticUnderstandingCandidate {
  affected_component_ids: string[];
  invariant_ids: string[];
  risk_ids: string[];
  unknown_ids: string[];
  rejected_assumption_ids: string[];
}

export interface SemanticUnderstandingScore {
  schema_version: "1.0";
  component_recall: number;
  component_precision: number;
  invariant_recall: number;
  risk_recall: number;
  unknown_recall: number;
  rejected_assumption_recall: number;
  critical_recall: number;
  unnecessary_selection_rate: number;
  weighted_quality: number;
  critical_misses: string[];
  missing_required: string[];
  unexpected_selected: string[];
}

type CandidateField = keyof SemanticUnderstandingCandidate;
type GoldField = Exclude<keyof SemanticUnderstandingGold, "critical_ids">;

const FIELD_PAIRS: Array<{ candidate: CandidateField; gold: GoldField; weight: number }> = [
  { candidate: "affected_component_ids", gold: "required_component_ids", weight: 0.2 },
  { candidate: "invariant_ids", gold: "required_invariant_ids", weight: 0.25 },
  { candidate: "risk_ids", gold: "required_risk_ids", weight: 0.2 },
  { candidate: "unknown_ids", gold: "required_unknown_ids", weight: 0.15 },
  { candidate: "rejected_assumption_ids", gold: "rejected_assumption_ids", weight: 0.2 },
];

function normalizedIds(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string" || !/^[A-Z][A-Z0-9_-]{1,63}$/.test(raw)) throw new Error(`${label} contains an invalid semantic ID.`);
    if (seen.has(raw)) throw new Error(`${label} contains duplicate semantic ID '${raw}'.`);
    seen.add(raw);
    result.push(raw);
  }
  return result;
}

function recall(selected: readonly string[], required: readonly string[]): number {
  if (required.length === 0) return 1;
  const chosen = new Set(selected);
  return required.filter((id) => chosen.has(id)).length / required.length;
}

function precision(selected: readonly string[], required: readonly string[]): number {
  if (selected.length === 0) return required.length === 0 ? 1 : 0;
  const truth = new Set(required);
  return selected.filter((id) => truth.has(id)).length / selected.length;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function allRequired(gold: SemanticUnderstandingGold): string[] {
  return FIELD_PAIRS.flatMap(({ gold: key }) => gold[key]);
}

function allSelected(candidate: SemanticUnderstandingCandidate): string[] {
  return FIELD_PAIRS.flatMap(({ candidate: key }) => candidate[key]);
}

export function scoreSemanticUnderstanding(rawCandidate: SemanticUnderstandingCandidate, rawGold: SemanticUnderstandingGold): SemanticUnderstandingScore {
  const candidate: SemanticUnderstandingCandidate = {
    affected_component_ids: normalizedIds(rawCandidate.affected_component_ids, "affected_component_ids"),
    invariant_ids: normalizedIds(rawCandidate.invariant_ids, "invariant_ids"),
    risk_ids: normalizedIds(rawCandidate.risk_ids, "risk_ids"),
    unknown_ids: normalizedIds(rawCandidate.unknown_ids, "unknown_ids"),
    rejected_assumption_ids: normalizedIds(rawCandidate.rejected_assumption_ids, "rejected_assumption_ids"),
  };
  const gold: SemanticUnderstandingGold = {
    required_component_ids: normalizedIds(rawGold.required_component_ids, "required_component_ids"),
    required_invariant_ids: normalizedIds(rawGold.required_invariant_ids, "required_invariant_ids"),
    required_risk_ids: normalizedIds(rawGold.required_risk_ids, "required_risk_ids"),
    required_unknown_ids: normalizedIds(rawGold.required_unknown_ids, "required_unknown_ids"),
    rejected_assumption_ids: normalizedIds(rawGold.rejected_assumption_ids, "rejected_assumption_ids"),
    critical_ids: normalizedIds(rawGold.critical_ids, "critical_ids"),
  };

  const required = allRequired(gold);
  const requiredSet = new Set(required);
  for (const id of gold.critical_ids) {
    if (!requiredSet.has(id)) throw new Error(`critical_ids contains '${id}' which is not a required semantic item.`);
  }

  const selected = allSelected(candidate);
  const selectedSet = new Set(selected);
  const missingRequired = required.filter((id) => !selectedSet.has(id));
  const unexpected = selected.filter((id) => !requiredSet.has(id));
  const criticalMisses = gold.critical_ids.filter((id) => !selectedSet.has(id));

  const componentRecall = recall(candidate.affected_component_ids, gold.required_component_ids);
  const componentPrecision = precision(candidate.affected_component_ids, gold.required_component_ids);
  const invariantRecall = recall(candidate.invariant_ids, gold.required_invariant_ids);
  const riskRecall = recall(candidate.risk_ids, gold.required_risk_ids);
  const unknownRecall = recall(candidate.unknown_ids, gold.required_unknown_ids);
  const rejectedAssumptionRecall = recall(candidate.rejected_assumption_ids, gold.rejected_assumption_ids);
  const criticalRecall = recall(selected, gold.critical_ids);
  const unnecessaryRate = selected.length === 0 ? 0 : unexpected.length / selected.length;

  const weightedRecall = FIELD_PAIRS.reduce((sum, pair) => sum + pair.weight * recall(candidate[pair.candidate], gold[pair.gold]), 0);
  // Critical misses are deliberately expensive: a candidate that overlooks an
  // authority/recovery invariant must not look healthy because it named many
  // low-value details. Unnecessary scope is a smaller but explicit penalty.
  const criticalPenalty = criticalMisses.length === 0 ? 0 : Math.min(0.5, 0.2 + 0.1 * criticalMisses.length);
  const scopePenalty = Math.min(0.2, unnecessaryRate * 0.2);
  const quality = Math.max(0, weightedRecall - criticalPenalty - scopePenalty);

  return {
    schema_version: "1.0",
    component_recall: rounded(componentRecall),
    component_precision: rounded(componentPrecision),
    invariant_recall: rounded(invariantRecall),
    risk_recall: rounded(riskRecall),
    unknown_recall: rounded(unknownRecall),
    rejected_assumption_recall: rounded(rejectedAssumptionRecall),
    critical_recall: rounded(criticalRecall),
    unnecessary_selection_rate: rounded(unnecessaryRate),
    weighted_quality: rounded(quality),
    critical_misses: criticalMisses,
    missing_required: missingRequired,
    unexpected_selected: unexpected,
  };
}
