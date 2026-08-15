import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseSemanticBenchmarkCorpus, publicSemanticBenchmarkCase, scoreSemanticCorpus } from "../src/benchmark/semantic-corpus.js";
import type { SemanticUnderstandingCandidate } from "../src/benchmark/semantic-understanding.js";

async function fixtureValue(): Promise<unknown> {
  const target = path.resolve("tests/fixtures/semantic-understanding/cases.json");
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}

function perfectCandidate(item: ReturnType<typeof parseSemanticBenchmarkCorpus>["cases"][number]): SemanticUnderstandingCandidate {
  return {
    affected_component_ids: [...item.gold.required_component_ids],
    invariant_ids: [...item.gold.required_invariant_ids],
    risk_ids: [...item.gold.required_risk_ids],
    unknown_ids: [...item.gold.required_unknown_ids],
    rejected_assumption_ids: [...item.gold.rejected_assumption_ids],
  };
}

function selectEverythingCandidate(item: ReturnType<typeof parseSemanticBenchmarkCorpus>["cases"][number]): SemanticUnderstandingCandidate {
  const ids = (category: string) => item.evidence_catalog.filter((entry) => entry.category === category).map((entry) => entry.id);
  return {
    affected_component_ids: ids("component"),
    invariant_ids: ids("invariant"),
    risk_ids: ids("risk"),
    unknown_ids: ids("unknown"),
    rejected_assumption_ids: ids("assumption"),
  };
}

test("semantic benchmark corpus is valid, nontrivial, and public cases do not leak gold", async () => {
  const corpus = parseSemanticBenchmarkCorpus(await fixtureValue());
  assert.equal(corpus.cases.length, 6);
  for (const item of corpus.cases) {
    const required = new Set([
      ...item.gold.required_component_ids,
      ...item.gold.required_invariant_ids,
      ...item.gold.required_risk_ids,
      ...item.gold.required_unknown_ids,
      ...item.gold.rejected_assumption_ids,
    ]);
    assert.ok(item.evidence_catalog.some((entry) => !required.has(entry.id)), `${item.case_id} must contain distractor evidence`);
    const publicCase = publicSemanticBenchmarkCase(item) as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(publicCase, "gold"), false);
    assert.deepEqual(Object.keys(publicCase).sort(), ["case_id", "category", "evidence_catalog", "goal"]);
  }
});

test("perfect hidden-gold selections score 1.0 across the semantic corpus", async () => {
  const corpus = parseSemanticBenchmarkCorpus(await fixtureValue());
  const candidates = new Map(corpus.cases.map((item) => [item.case_id, perfectCandidate(item)]));
  const report = scoreSemanticCorpus(corpus, candidates);
  assert.equal(report.cases, corpus.cases.length);
  assert.equal(report.perfect_cases, corpus.cases.length);
  assert.equal(report.cases_with_critical_miss, 0);
  assert.equal(report.weighted_quality_mean, 1);
  assert.equal(report.critical_recall_mean, 1);
  assert.equal(report.unnecessary_selection_rate_mean, 0);
});

test("select-everything benchmark gaming keeps recall but loses precision and quality", async () => {
  const corpus = parseSemanticBenchmarkCorpus(await fixtureValue());
  const candidates = new Map(corpus.cases.map((item) => [item.case_id, selectEverythingCandidate(item)]));
  const report = scoreSemanticCorpus(corpus, candidates);
  process.stdout.write(`SEMANTIC_SANITY select_all_quality=${report.weighted_quality_mean} unnecessary_selection=${report.unnecessary_selection_rate_mean}\n`);
  assert.equal(report.cases_with_critical_miss, 0);
  assert.ok(report.unnecessary_selection_rate_mean > 0);
  assert.ok(report.weighted_quality_mean < 0.95, `select-all quality ${report.weighted_quality_mean} is too forgiving`);
  assert.ok(report.perfect_cases < corpus.cases.length);
});

test("empty understanding is a hard failure on critical semantic coverage", async () => {
  const corpus = parseSemanticBenchmarkCorpus(await fixtureValue());
  const empty: SemanticUnderstandingCandidate = {
    affected_component_ids: [],
    invariant_ids: [],
    risk_ids: [],
    unknown_ids: [],
    rejected_assumption_ids: [],
  };
  const candidates = new Map(corpus.cases.map((item) => [item.case_id, empty]));
  const report = scoreSemanticCorpus(corpus, candidates);
  assert.equal(report.cases_with_critical_miss, corpus.cases.length);
  assert.equal(report.critical_recall_mean, 0);
  assert.equal(report.weighted_quality_mean, 0);
});

test("corpus validation rejects gold leakage through wrong category bindings", async () => {
  const raw = await fixtureValue() as any;
  raw.cases[0].gold.required_risk_ids.push("C_THEME");
  assert.throws(() => parseSemanticBenchmarkCorpus(raw), /catalogued as component, expected risk/i);
});
