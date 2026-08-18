import { createHash } from "node:crypto";
import { chatGptCodexReviewPrompt, chatGptCodexReviewRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";

const LOOKUPS = 3;
const MINIMUM_REDUCTION = 0.50;
const request = {
  run_id: `TASK-RELAY:${"a".repeat(64)}`,
  result_bundle_sha256: "b".repeat(64),
  published_commit_sha: "c".repeat(40),
  pull_request_url: "https://github.com/example/project/pull/1",
  review_round: 1,
} as const;

function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

// A deterministic, explicitly declared baseline for the relay problem WCO is
// intended to eliminate: every manual reviewer round receives the same full
// result evidence again, plus the newly inspected exact source. This does NOT
// estimate provider tokens and deliberately uses plain UTF-8 source for both
// paths so base64 expansion cannot make WCO look artificially better.
const evidence = {
  purpose: "independent_code_review",
  binding: request,
  entries: {
    "repository/diff.patch": { content_utf8: `diff --git a/src/service.ts b/src/service.ts\n${"+changed behavior\n".repeat(2_500)}` },
    "evidence/verification.json": { content_utf8: JSON.stringify({ commands: Array.from({ length: 100 }, (_, index) => ({ id: index, status: "PASS", output: "verified".repeat(8) })) }) },
    "task/acceptance.json": { content_utf8: JSON.stringify({ criteria: Array.from({ length: 40 }, (_, index) => ({ id: `AC-${index}`, status: "PASS", description: "user-visible acceptance behavior" })) }) },
  },
};
const initial = chatGptCodexReviewPrompt(request, evidence as any, "review-relay-benchmark");

const repositoryResults = Array.from({ length: LOOKUPS }, (_, index) => {
  const source = Buffer.from(`// caller ${index}\n${"export function caller() { return preserveInvariant(); }\n".repeat(160)}`, "utf8");
  return {
    files: [{
      path: `src/caller-${index}.ts`,
      content_base64: source.toString("base64"),
      content_sha256: sha(source),
      blob_sha: `${index + 1}`.repeat(40).slice(0, 40),
      size_bytes: source.byteLength,
      start_byte: 0,
      end_byte_exclusive: source.byteLength,
      total_bytes: source.byteLength,
    }],
  };
});

let manualFullContextBytes = bytes(initial);
let wcoBoundedRelayBytes = bytes(initial);
let rawRepositoryWireBytes = 0;
let semanticRepositoryBytes = 0;
for (const result of repositoryResults) {
  const sourceText = Buffer.from(result.files[0].content_base64, "base64").toString("utf8");
  // Manual/full-context baseline retransmits the original context and the new
  // source as readable UTF-8 on every inspection round.
  manualFullContextBytes += bytes(initial) + bytes(sourceText);

  const followUp = chatGptCodexReviewRepositoryResultPrompt(result, request, "review-relay-benchmark");
  wcoBoundedRelayBytes += bytes(followUp);
  rawRepositoryWireBytes += bytes(JSON.stringify(result));
  const marker = '"content_utf8":';
  if (!followUp.includes(marker) || followUp.includes('"content_base64":')) throw new Error("relay benchmark: exact UTF-8 repository evidence was not converted to readable semantic context");
  semanticRepositoryBytes += bytes(sourceText);
}

const reduction = 1 - wcoBoundedRelayBytes / manualFullContextBytes;
if (reduction < MINIMUM_REDUCTION) {
  throw new Error(`relay benchmark failed: ${(reduction * 100).toFixed(2)}% repeated-context reduction is below ${(MINIMUM_REDUCTION * 100).toFixed(0)}%`);
}
if (semanticRepositoryBytes >= rawRepositoryWireBytes) {
  throw new Error("relay benchmark failed: readable UTF-8 source did not reduce repository transport footprint relative to exact base64 wire JSON");
}

console.log(JSON.stringify({
  benchmark: "review-relay-efficiency-v1",
  baseline: "full initial review context retransmitted on each bounded source lookup; readable UTF-8 source on both paths",
  lookups: LOOKUPS,
  manual_full_context_bytes: manualFullContextBytes,
  wco_bounded_relay_bytes: wcoBoundedRelayBytes,
  repeated_context_reduction_percent: Number((reduction * 100).toFixed(2)),
  repository_base64_wire_json_bytes: rawRepositoryWireBytes,
  repository_utf8_source_bytes: semanticRepositoryBytes,
  gate_minimum_reduction_percent: MINIMUM_REDUCTION * 100,
  caveat: "Bytes measure deterministic relay/context transfer only; they are not provider token counts or a task-quality score.",
}, null, 2));
