import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemanticBenchmarkArms,
  type SemanticBenchmarkArmResult,
} from "../src/benchmark/semantic-challenge-evaluation.js";
import {
  qualifySemanticProviderBenchmark,
  type SemanticProviderUsage,
} from "../src/benchmark/semantic-provider-qualification.js";

interface SampleInput {
  case_id: string;
  weighted_quality: number;
  critical_recall: number;
  unnecessary_selection_rate: number;
  critical_misses?: string[];
}

function mean(values: number[]): number {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function arm(name: string, samples: SampleInput[]): SemanticBenchmarkArmResult {
  return {
    schema_version: "1.0",
    kind: "semantic-benchmark-arm",
    arm: name,
    provider_turns: samples.length,
    report: {
      schema_version: "1.0",
      kind: "semantic-understanding-corpus",
      cases: samples.length,
      perfect_cases: samples.filter((sample) => sample.weighted_quality === 1 && (sample.critical_misses?.length ?? 0) === 0).length,
      cases_with_critical_miss: samples.filter((sample) => (sample.critical_misses?.length ?? 0) > 0).length,
      weighted_quality_mean: mean(samples.map((sample) => sample.weighted_quality)),
      critical_recall_mean: mean(samples.map((sample) => sample.critical_recall)),
      unnecessary_selection_rate_mean: mean(samples.map((sample) => sample.unnecessary_selection_rate)),
      samples: samples.map((sample) => ({
        case_id: sample.case_id,
        score: {
          weighted_quality: sample.weighted_quality,
          critical_recall: sample.critical_recall,
          unnecessary_selection_rate: sample.unnecessary_selection_rate,
          critical_misses: sample.critical_misses ?? [],
        } as any,
      })),
    },
  };
}

function usage(turns: number, inputTokens: number, outputTokens = 0, cachedInputTokens = 0): SemanticProviderUsage {
  return {
    turns,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
  };
}

function qualify(baseline: SemanticBenchmarkArmResult, challenger: SemanticBenchmarkArmResult, baselineUsage: SemanticProviderUsage, challengerUsage: SemanticProviderUsage) {
  return qualifySemanticProviderBenchmark({
    baseline,
    challenger,
    comparison: compareSemanticBenchmarkArms(baseline, challenger),
    baseline_usage: baselineUsage,
    challenger_usage: challengerUsage,
  });
}

test("provider qualification passes measurable semantic uplift even when it costs more tokens inside the configured budget", () => {
  const baseline = arm("author_style", [{ case_id: "CASE_A", weighted_quality: 0.7, critical_recall: 1, unnecessary_selection_rate: 0.3 }]);
  const challenger = arm("independent_challenger", [{ case_id: "CASE_A", weighted_quality: 0.8, critical_recall: 1, unnecessary_selection_rate: 0.2 }]);
  const result = qualify(baseline, challenger, usage(1, 100, 20), usage(1, 130, 30));

  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.semantic_improvement_observed, true);
  assert.equal(result.total_token_delta, 40);
  assert.equal(result.challenger_token_ratio, 1.3333);
});

test("provider qualification fails on a new critical miss even when aggregate miss count and recall are unchanged", () => {
  const baseline = arm("author_style", [
    { case_id: "CASE_A", weighted_quality: 0.7, critical_recall: 0.5, unnecessary_selection_rate: 0.2, critical_misses: ["A_CRIT"] },
    { case_id: "CASE_B", weighted_quality: 0.9, critical_recall: 1, unnecessary_selection_rate: 0.1 },
  ]);
  const challenger = arm("independent_challenger", [
    { case_id: "CASE_A", weighted_quality: 0.9, critical_recall: 1, unnecessary_selection_rate: 0.1 },
    { case_id: "CASE_B", weighted_quality: 0.7, critical_recall: 0.5, unnecessary_selection_rate: 0.2, critical_misses: ["B_CRIT"] },
  ]);
  const result = qualify(baseline, challenger, usage(2, 200), usage(2, 200));

  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ["new_critical_misses"]);
  assert.deepEqual(result.new_critical_misses, [{ case_id: "CASE_B", ids: ["B_CRIT"] }]);
  assert.deepEqual(result.resolved_critical_misses, [{ case_id: "CASE_A", ids: ["A_CRIT"] }]);
});

test("provider qualification fails when aggregate critical recall or weighted quality regresses", () => {
  const baseline = arm("author_style", [{ case_id: "CASE_A", weighted_quality: 0.8, critical_recall: 1, unnecessary_selection_rate: 0.2 }]);
  const challenger = arm("independent_challenger", [{ case_id: "CASE_A", weighted_quality: 0.7, critical_recall: 0.5, unnecessary_selection_rate: 0.1, critical_misses: ["CRIT_A"] }]);
  const result = qualify(baseline, challenger, usage(1, 100), usage(1, 90));

  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, [
    "new_critical_misses",
    "critical_recall_regressed",
    "critical_miss_cases_increased",
    "weighted_quality_regressed",
  ]);
});

test("provider qualification rejects extra tokens when no measured semantic metric improves", () => {
  const samples = [{ case_id: "CASE_A", weighted_quality: 0.8, critical_recall: 1, unnecessary_selection_rate: 0.2 }];
  const baseline = arm("author_style", samples);
  const challenger = arm("independent_challenger", samples);
  const result = qualify(baseline, challenger, usage(1, 100, 10), usage(1, 120, 10));

  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ["extra_tokens_without_semantic_gain"]);
  assert.equal(result.semantic_improvement_observed, false);
  assert.equal(result.semantic_regression_observed, false);
});

test("provider qualification accepts equal semantics at lower token cost without inventing an uplift claim", () => {
  const samples = [{ case_id: "CASE_A", weighted_quality: 0.8, critical_recall: 1, unnecessary_selection_rate: 0.2 }];
  const baseline = arm("author_style", samples);
  const challenger = arm("independent_challenger", samples);
  const result = qualify(baseline, challenger, usage(1, 120, 20), usage(1, 90, 20));

  assert.equal(result.pass, true);
  assert.equal(result.semantic_improvement_observed, false);
  assert.equal(result.total_token_delta, -30);
});

test("provider qualification fails closed on invalid usage evidence or turn-count drift", () => {
  const samples = [{ case_id: "CASE_A", weighted_quality: 0.8, critical_recall: 1, unnecessary_selection_rate: 0.2 }];
  const baseline = arm("author_style", samples);
  const challenger = arm("independent_challenger", samples);
  const comparison = compareSemanticBenchmarkArms(baseline, challenger);

  assert.throws(() => qualifySemanticProviderBenchmark({
    baseline,
    challenger,
    comparison,
    baseline_usage: usage(1, 100, 0, 101),
    challenger_usage: usage(1, 100),
  }), /cached_input_tokens exceeds input_tokens/i);

  assert.throws(() => qualifySemanticProviderBenchmark({
    baseline,
    challenger,
    comparison,
    baseline_usage: usage(2, 100),
    challenger_usage: usage(1, 100),
  }), /usage turns do not match benchmark provider-turn evidence/i);
});
