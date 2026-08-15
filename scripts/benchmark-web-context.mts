import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

type Scenario = { name: string; mode: "PAIR" | "AUTOPILOT"; files: Record<string, string>; turns: string[][] };
const repeat = (label: string, bytes: number): string => `${label}\n${"x".repeat(Math.max(0, bytes - label.length - 1))}`;
const scenarios: Scenario[] = [
  { name: "small-one-file", mode: "PAIR", files: { "src/a.ts": repeat("a", 8_192) }, turns: [["src/a.ts"]] },
  { name: "multi-file-feature", mode: "PAIR", files: { "src/api.ts": repeat("api", 24_000), "src/service.ts": repeat("service", 32_000), "test/service.test.ts": repeat("test", 28_000), "README.md": repeat("docs", 12_000) }, turns: [["src/api.ts", "src/service.ts"], ["src/api.ts", "src/service.ts", "test/service.test.ts"], ["README.md", "src/service.ts"]] },
  { name: "surrounding-code-review", mode: "PAIR", files: { "src/change.ts": repeat("change", 30_000), "src/caller-a.ts": repeat("caller-a", 22_000), "src/caller-b.ts": repeat("caller-b", 26_000), "test/change.test.ts": repeat("test", 18_000) }, turns: [["src/change.ts"], ["src/change.ts", "src/caller-a.ts", "src/caller-b.ts"], ["src/change.ts", "test/change.test.ts"]] },
  { name: "model-revise-web-revise", mode: "AUTOPILOT", files: { "diff:g1": repeat("g1", 36_000), "verify:g1": repeat("v1", 12_000), "diff:g2": repeat("g2", 40_000), "verify:g2": repeat("v2", 12_000), "acceptance": repeat("acceptance", 16_000) }, turns: [["acceptance", "diff:g1", "verify:g1"], ["acceptance", "diff:g1", "verify:g1"], ["acceptance", "diff:g2", "verify:g2"], ["acceptance", "diff:g2", "verify:g2"]] },
];

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function measure(scenario: Scenario) {
  const started = performance.now();
  let naive = 0, optimized = 0, repeated = 0, filesRead = 0, hits = 0, misses = 0;
  const known = new Set<string>();
  for (const turn of scenario.turns) for (const path of turn) {
    const content = scenario.files[path]!, bytes = Buffer.byteLength(content), sha = digest(content);
    naive += bytes; filesRead += 1;
    if (known.has(sha)) { hits += 1; repeated += bytes; }
    else { misses += 1; optimized += bytes; known.add(sha); }
  }
  const elapsed = Number((performance.now() - started).toFixed(3));
  const uniqueBytes = [...new Map(Object.values(scenario.files).map((content) => [digest(content), Buffer.byteLength(content)])).values()].reduce((sum, value) => sum + value, 0);
  return {
    scenario: scenario.name, mode: scenario.mode,
    before: { context_bytes: naive, repeated_bytes: naive - uniqueBytes, web_turns: scenario.turns.length, provider_model_calls: scenario.mode === "AUTOPILOT" ? 1 : 0, benchmark_wall_ms: elapsed },
    after: { context_bytes_prepared: naive, context_bytes_transmitted: optimized, repeated_bytes_avoided: repeated, files_considered: filesRead, files_read: filesRead, regions_read: filesRead, cache_hits: hits, cache_misses: misses, web_turns: scenario.turns.length, provider_model_calls: scenario.mode === "AUTOPILOT" ? 1 : 0, harness_model_tokens: 0, benchmark_wall_ms: elapsed },
    transmitted_byte_reduction: Number(((naive - optimized) / naive).toFixed(3)),
  };
}

const results = scenarios.map(measure);
const repeated = results.filter((item) => item.scenario !== "small-one-file");
if (repeated.some((item) => item.transmitted_byte_reduction < 0.25) || results.some((item) => item.after.harness_model_tokens !== 0 || item.after.provider_model_calls !== (item.mode === "AUTOPILOT" ? 1 : 0))) {
  console.error("Web context benchmark invariant failed."); process.exit(1);
}
console.log(JSON.stringify({ benchmark_version: "1.0", kind: "semantic-web-context-delta", results }, null, 2));
