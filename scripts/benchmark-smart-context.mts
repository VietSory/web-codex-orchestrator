import { performance } from "node:perf_hooks";
import { selectSmartContext } from "../src/executor/smart-context.js";
import type { WebImplementationPack } from "../src/web-authority/contracts.js";

const candidateCount = 1_000;
const reads = Array.from({ length: candidateCount }, (_, index) => ({
  path: `packages/domain-${String(index).padStart(4, "0")}/src/component-with-descriptive-name.ts`,
  coverage: index % 3 === 0 ? "partial" as const : "full" as const,
  object_sha: "b".repeat(40),
}));
const entries = new Map<string, Buffer>([
  ["read-coverage.json", Buffer.from(JSON.stringify({ schema_version: "2.0", repository_tree_sha: "a".repeat(40), reads }))],
  ["project-map.json", Buffer.from(JSON.stringify({ schema_version: "2.0", repository_tree_sha: "a".repeat(40), nodes: [{ path: "src/change.ts", role: "changed" }] }))],
]);
const pack = { entries } as unknown as WebImplementationPack;

const started = performance.now();
const selection = selectSmartContext(pack, ["src/change.ts"]);
const elapsedMs = performance.now() - started;
const candidatePathBytes = reads.reduce((sum, entry) => sum + Buffer.byteLength(entry.path, "utf8"), 0);
const selectedPathBytes = selection.paths.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8"), 0);
const retainedRatio = selectedPathBytes / candidatePathBytes;

const report = {
  benchmark_version: "1.0",
  kind: "deterministic-context-path-selection",
  candidate_count: candidateCount,
  selected_count: selection.paths.length,
  candidate_path_bytes: candidatePathBytes,
  selected_path_bytes: selectedPathBytes,
  retained_path_byte_ratio: Number(retainedRatio.toFixed(6)),
  selector_elapsed_ms: Number(elapsedMs.toFixed(3)),
  selection_sha256: selection.selection_sha256,
  note: "This measures deterministic context-path selection only. It does not claim provider token, latency, cost, or task-success savings.",
};

console.log(JSON.stringify(report, null, 2));
if (selection.paths.length > 24 || !selection.truncated || retainedRatio >= 0.1) {
  console.error("Smart-context benchmark invariant failed.");
  process.exitCode = 1;
}
