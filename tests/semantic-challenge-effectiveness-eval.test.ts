import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  compareSemanticBenchmarkArms,
  evaluateSemanticBenchmarkArm,
  parseSemanticBenchmarkSelection,
  semanticBenchmarkSelectionPrompt,
} from "../src/benchmark/semantic-challenge-evaluation.js";
import { parseSemanticBenchmarkCorpus, publicSemanticBenchmarkCase } from "../src/benchmark/semantic-corpus.js";

async function corpus() {
  const raw = JSON.parse(await readFile(path.resolve("tests/fixtures/semantic-understanding/cases.json"), "utf8")) as unknown;
  return parseSemanticBenchmarkCorpus(raw);
}

function selection(caseId: string, ids: string[]) {
  return { schema_version: "1.0", kind: "semantic-benchmark-selection", case_id: caseId, selected_ids: ids };
}

test("benchmark provider prompt exposes public evidence but never hidden gold", async () => {
  const value = await corpus();
  const item = publicSemanticBenchmarkCase(value.cases[0]!);
  const prompt = semanticBenchmarkSelectionPrompt(item);
  assert.match(prompt, new RegExp(item.case_id));
  assert.match(prompt, new RegExp(item.evidence_catalog[0]!.id));
  assert.equal(prompt.includes("required_component_ids"), false);
  assert.equal(prompt.includes("critical_ids"), false);
  assert.equal(prompt.includes("rejected_assumption_ids"), false);
});

test("oracle benchmark arm scores hidden gold perfectly without provider gold access", async () => {
  const value = await corpus();
  const goldByCase = new Map(value.cases.map((item) => [item.case_id, item.gold]));
  const arm = await evaluateSemanticBenchmarkArm({
    arm: "oracle_test",
    corpus: value,
    provider: async ({ case_id, prompt, public_case }) => {
      const gold = goldByCase.get(case_id)!;
      assert.equal(prompt.includes("critical_ids"), false);
      assert.equal("gold" in public_case, false);
      return selection(case_id, [
        ...gold.required_component_ids,
        ...gold.required_invariant_ids,
        ...gold.required_risk_ids,
        ...gold.required_unknown_ids,
        ...gold.rejected_assumption_ids,
      ]);
    },
  });
  assert.equal(arm.provider_turns, value.cases.length);
  assert.equal(arm.report.weighted_quality_mean, 1);
  assert.equal(arm.report.critical_recall_mean, 1);
  assert.equal(arm.report.cases_with_critical_miss, 0);
});

test("comparison reports measurable uplift over a select-everything baseline", async () => {
  const value = await corpus();
  const baseline = await evaluateSemanticBenchmarkArm({
    arm: "baseline_select_all",
    corpus: value,
    provider: async ({ case_id, public_case }) => selection(case_id, public_case.evidence_catalog.map((entry) => entry.id)),
  });
  const goldByCase = new Map(value.cases.map((item) => [item.case_id, item.gold]));
  const challenger = await evaluateSemanticBenchmarkArm({
    arm: "challenger_oracle",
    corpus: value,
    provider: async ({ case_id }) => {
      const gold = goldByCase.get(case_id)!;
      return selection(case_id, [
        ...gold.required_component_ids,
        ...gold.required_invariant_ids,
        ...gold.required_risk_ids,
        ...gold.required_unknown_ids,
        ...gold.rejected_assumption_ids,
      ]);
    },
  });
  const comparison = compareSemanticBenchmarkArms(baseline, challenger);
  assert.ok(comparison.weighted_quality_delta > 0);
  assert.ok(comparison.unnecessary_selection_rate_delta < 0);
  assert.equal(comparison.critical_recall_delta, 0, "select-all already recalls critical truth; precision is what must improve");
  assert.equal(comparison.challenger_worse_cases.length, 0);
  assert.equal(comparison.challenger_better_cases.length, value.cases.length);
});

test("selection parser rejects hidden/non-public IDs, duplicates, and cross-case replay", async () => {
  const value = await corpus();
  const first = publicSemanticBenchmarkCase(value.cases[0]!);
  const second = publicSemanticBenchmarkCase(value.cases[1]!);
  await assert.rejects(async () => parseSemanticBenchmarkSelection(selection(first.case_id, ["NOT_PUBLIC"]), first), /non-public evidence/i);
  const known = first.evidence_catalog[0]!.id;
  await assert.rejects(async () => parseSemanticBenchmarkSelection(selection(first.case_id, [known, known]), first), /duplicates evidence/i);
  await assert.rejects(async () => parseSemanticBenchmarkSelection(selection(first.case_id, [known]), second), /identity is invalid/i);
});

test("arm evaluator counts exactly one provider turn per public case and fails closed on malformed output", async () => {
  const value = await corpus();
  let turns = 0;
  await assert.rejects(
    evaluateSemanticBenchmarkArm({
      arm: "malformed_test",
      corpus: value,
      provider: async ({ case_id }) => {
        turns += 1;
        return { schema_version: "1.0", kind: "semantic-benchmark-selection", case_id, selected_ids: ["FORGED_ID"] };
      },
    }),
    /non-public evidence/i,
  );
  assert.equal(turns, 1, "malformed first provider output must stop before spending more benchmark turns");
});
