import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSemanticBenchmarkCorpus, scoreSemanticCorpus } from "../src/benchmark/semantic-corpus.js";
import type { SemanticUnderstandingCandidate } from "../src/benchmark/semantic-understanding.js";

const corpusPath = path.resolve("tests/fixtures/semantic-understanding/cases.json");
const corpus = parseSemanticBenchmarkCorpus(JSON.parse(await readFile(corpusPath, "utf8")) as unknown);

function oracle(item: (typeof corpus.cases)[number]): SemanticUnderstandingCandidate {
  return {
    affected_component_ids: [...item.gold.required_component_ids],
    invariant_ids: [...item.gold.required_invariant_ids],
    risk_ids: [...item.gold.required_risk_ids],
    unknown_ids: [...item.gold.required_unknown_ids],
    rejected_assumption_ids: [...item.gold.rejected_assumption_ids],
  };
}

function selectAll(item: (typeof corpus.cases)[number]): SemanticUnderstandingCandidate {
  const ids = (category: string) => item.evidence_catalog.filter((entry) => entry.category === category).map((entry) => entry.id);
  return {
    affected_component_ids: ids("component"),
    invariant_ids: ids("invariant"),
    risk_ids: ids("risk"),
    unknown_ids: ids("unknown"),
    rejected_assumption_ids: ids("assumption"),
  };
}

const empty: SemanticUnderstandingCandidate = {
  affected_component_ids: [],
  invariant_ids: [],
  risk_ids: [],
  unknown_ids: [],
  rejected_assumption_ids: [],
};

function candidates(factory: (item: (typeof corpus.cases)[number]) => SemanticUnderstandingCandidate) {
  return new Map(corpus.cases.map((item) => [item.case_id, factory(item)]));
}

const oracleReport = scoreSemanticCorpus(corpus, candidates(oracle));
const selectAllReport = scoreSemanticCorpus(corpus, candidates(selectAll));
const emptyReport = scoreSemanticCorpus(corpus, candidates(() => empty));

if (oracleReport.weighted_quality_mean !== 1 || oracleReport.critical_recall_mean !== 1) {
  throw new Error("Semantic benchmark integrity failure: hidden-gold oracle does not score 1.0.");
}
if (emptyReport.weighted_quality_mean !== 0 || emptyReport.critical_recall_mean !== 0) {
  throw new Error("Semantic benchmark integrity failure: empty understanding is not a hard failure.");
}
if (!(selectAllReport.weighted_quality_mean < 0.95 && selectAllReport.unnecessary_selection_rate_mean > 0)) {
  throw new Error("Semantic benchmark integrity failure: select-everything strategy is not penalized enough.");
}

console.log(JSON.stringify({
  benchmark_version: "1.0",
  corpus_schema_version: corpus.schema_version,
  corpus_cases: corpus.cases.length,
  provider_turns: 0,
  lifecycle_mutation: false,
  arms: {
    oracle: oracleReport,
    select_all: selectAllReport,
    empty: emptyReport,
  },
  note: "Integrity/sanity benchmark only. It validates the scorer and corpus; it is not evidence that any model or WCO semantic pipeline improved.",
}, null, 2));
