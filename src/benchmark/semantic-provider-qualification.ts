import type {
  SemanticBenchmarkArmResult,
  SemanticBenchmarkComparison,
} from "./semantic-challenge-evaluation.js";

export interface SemanticProviderUsage {
  turns: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface SemanticProviderCriticalMissDelta {
  case_id: string;
  ids: string[];
}

export interface SemanticProviderQualification {
  schema_version: "1.0";
  kind: "semantic-provider-qualification";
  pass: boolean;
  reasons: string[];
  baseline_total_tokens: number;
  challenger_total_tokens: number;
  total_token_delta: number;
  challenger_token_ratio: number | null;
  semantic_improvement_observed: boolean;
  semantic_regression_observed: boolean;
  new_critical_misses: SemanticProviderCriticalMissDelta[];
  resolved_critical_misses: SemanticProviderCriticalMissDelta[];
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`semantic provider qualification ${label} must be a non-negative safe integer.`);
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`semantic provider qualification ${label} overflowed safe integer accounting.`);
  return result;
}

function normalizeUsage(value: SemanticProviderUsage, label: string): SemanticProviderUsage {
  const usage = {
    turns: nonNegativeSafeInteger(value.turns, `${label}.turns`),
    input_tokens: nonNegativeSafeInteger(value.input_tokens, `${label}.input_tokens`),
    cached_input_tokens: nonNegativeSafeInteger(value.cached_input_tokens, `${label}.cached_input_tokens`),
    output_tokens: nonNegativeSafeInteger(value.output_tokens, `${label}.output_tokens`),
  };
  if (usage.cached_input_tokens > usage.input_tokens) throw new Error(`semantic provider qualification ${label}.cached_input_tokens exceeds input_tokens.`);
  return usage;
}

function totalTokens(usage: SemanticProviderUsage, label: string): number {
  return safeAdd(usage.input_tokens, usage.output_tokens, `${label} total tokens`);
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function criticalMissDeltas(
  baseline: SemanticBenchmarkArmResult,
  challenger: SemanticBenchmarkArmResult,
): { added: SemanticProviderCriticalMissDelta[]; resolved: SemanticProviderCriticalMissDelta[] } {
  const baselineByCase = new Map(baseline.report.samples.map((sample) => [sample.case_id, sample.score]));
  const challengerByCase = new Map(challenger.report.samples.map((sample) => [sample.case_id, sample.score]));
  if (baselineByCase.size !== challengerByCase.size || [...baselineByCase.keys()].some((caseId) => !challengerByCase.has(caseId))) {
    throw new Error("semantic provider qualification benchmark arms contain different case identities.");
  }

  const added: SemanticProviderCriticalMissDelta[] = [];
  const resolved: SemanticProviderCriticalMissDelta[] = [];
  for (const [caseId, baselineScore] of baselineByCase) {
    const challengerScore = challengerByCase.get(caseId)!;
    const baselineMisses = new Set(baselineScore.critical_misses);
    const challengerMisses = new Set(challengerScore.critical_misses);
    const newlyMissed = [...challengerMisses].filter((id) => !baselineMisses.has(id)).sort();
    const newlyResolved = [...baselineMisses].filter((id) => !challengerMisses.has(id)).sort();
    if (newlyMissed.length > 0) added.push({ case_id: caseId, ids: newlyMissed });
    if (newlyResolved.length > 0) resolved.push({ case_id: caseId, ids: newlyResolved });
  }
  return { added, resolved };
}

/**
 * Release qualification for the one-sample-per-case provider A/B.
 *
 * This deliberately avoids invented percentage tolerances and does not demand
 * per-case Pareto dominance from a stochastic directional benchmark. Instead
 * it enforces three evidence-backed floors:
 *   1. no newly introduced critical misses (including regressions hidden by
 *      aggregate miss counts),
 *   2. no aggregate critical-recall or weighted-quality regression, and
 *   3. no extra provider tokens unless at least one measured semantic metric
 *      improves.
 *
 * The configured AgentLimits remain the absolute resource ceiling; this gate
 * answers the separate question of whether the challenger spent more than the
 * baseline without measurable semantic benefit.
 */
export function qualifySemanticProviderBenchmark(options: {
  baseline: SemanticBenchmarkArmResult;
  challenger: SemanticBenchmarkArmResult;
  comparison: SemanticBenchmarkComparison;
  baseline_usage: SemanticProviderUsage;
  challenger_usage: SemanticProviderUsage;
}): SemanticProviderQualification {
  const { baseline, challenger, comparison } = options;
  if (comparison.baseline_arm !== baseline.arm || comparison.challenger_arm !== challenger.arm) {
    throw new Error("semantic provider qualification comparison arm identities do not match the measured arms.");
  }
  if (baseline.report.cases !== challenger.report.cases || baseline.report.cases !== baseline.report.samples.length || challenger.report.cases !== challenger.report.samples.length) {
    throw new Error("semantic provider qualification benchmark arm case counts are inconsistent.");
  }

  const baselineUsage = normalizeUsage(options.baseline_usage, "baseline_usage");
  const challengerUsage = normalizeUsage(options.challenger_usage, "challenger_usage");
  if (baselineUsage.turns !== baseline.provider_turns || challengerUsage.turns !== challenger.provider_turns) {
    throw new Error("semantic provider qualification usage turns do not match benchmark provider-turn evidence.");
  }

  const baselineTotalTokens = totalTokens(baselineUsage, "baseline");
  const challengerTotalTokens = totalTokens(challengerUsage, "challenger");
  const misses = criticalMissDeltas(baseline, challenger);
  const semanticImprovementObserved = comparison.weighted_quality_delta > 0
    || comparison.critical_recall_delta > 0
    || comparison.critical_miss_case_delta < 0
    || comparison.unnecessary_selection_rate_delta < 0
    || misses.resolved.length > 0;
  const semanticRegressionObserved = comparison.weighted_quality_delta < 0
    || comparison.critical_recall_delta < 0
    || comparison.critical_miss_case_delta > 0
    || comparison.unnecessary_selection_rate_delta > 0
    || misses.added.length > 0;

  const reasons: string[] = [];
  if (misses.added.length > 0) reasons.push("new_critical_misses");
  if (comparison.critical_recall_delta < 0) reasons.push("critical_recall_regressed");
  if (comparison.critical_miss_case_delta > 0) reasons.push("critical_miss_cases_increased");
  if (comparison.weighted_quality_delta < 0) reasons.push("weighted_quality_regressed");
  if (challengerTotalTokens > baselineTotalTokens && !semanticImprovementObserved) reasons.push("extra_tokens_without_semantic_gain");

  return {
    schema_version: "1.0",
    kind: "semantic-provider-qualification",
    pass: reasons.length === 0,
    reasons,
    baseline_total_tokens: baselineTotalTokens,
    challenger_total_tokens: challengerTotalTokens,
    total_token_delta: challengerTotalTokens - baselineTotalTokens,
    challenger_token_ratio: baselineTotalTokens === 0 ? null : rounded(challengerTotalTokens / baselineTotalTokens),
    semantic_improvement_observed: semanticImprovementObserved,
    semantic_regression_observed: semanticRegressionObserved,
    new_critical_misses: misses.added,
    resolved_critical_misses: misses.resolved,
  };
}
