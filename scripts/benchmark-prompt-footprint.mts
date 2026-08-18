import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chatGptCodexAuthorPrompt, chatGptCodexRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import type { AuthoringJobRequest } from "../src/web-bridge/web-bridge.js";

const request: AuthoringJobRequest = {
  owner: "local-user",
  repository: {
    repository_id: "github:example/production-fixture",
    base_branch: "main",
    base_commit: "a".repeat(40),
  },
  user_intent: "Add a production-safe account invitation flow with validation, regression tests, recovery behavior, and clear user-facing errors.",
  ttl_seconds: 3600,
  orchestration_mode: "PAIR",
};
const jobId = "job-prompt-footprint";

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertBound(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new Error(`${label} ${value} bytes exceeded the ${maximum}-byte production guardrail.`);
}

const author = chatGptCodexAuthorPrompt(request, jobId);
const smallResult = {
  operation: "read",
  repository_id: request.repository.repository_id,
  files: [{ path: "src/example.ts", content: "x".repeat(4_096), content_sha256: "b".repeat(64) }],
};
const mediumResult = {
  operation: "read",
  repository_id: request.repository.repository_id,
  files: [{ path: "src/example.ts", content: "x".repeat(65_536), content_sha256: "b".repeat(64) }],
};
const smallPrompt = chatGptCodexRepositoryResultPrompt(smallResult, request, jobId);
const mediumPrompt = chatGptCodexRepositoryResultPrompt(mediumResult, request, jobId);
const smallResultBytes = bytes(JSON.stringify(smallResult));
const mediumResultBytes = bytes(JSON.stringify(mediumResult));
const smallOverhead = bytes(smallPrompt) - smallResultBytes;
const mediumOverhead = bytes(mediumPrompt) - mediumResultBytes;

// These guardrails measure deterministic UTF-8 prompt footprint only. They do
// not claim provider token counts, cost, latency, cache behavior, or quality.
assertBound(bytes(author), 16 * 1024, "initial semantic author prompt");
assertBound(smallOverhead, 8 * 1024, "repository-result protocol/safety overhead");
assertBound(mediumOverhead, 8 * 1024, "repository-result protocol/safety overhead");
if (Math.abs(smallOverhead - mediumOverhead) > 256) {
  throw new Error(`repository-result prompt overhead should stay approximately constant; small=${smallOverhead}, medium=${mediumOverhead}`);
}
if (smallPrompt.includes('{"operation":"summary"}') || smallPrompt.includes("For kind=contract_sealed, payload_json must be")) {
  throw new Error("repository-result follow-up retransmitted the initial-turn schema tutorial instead of a compact continuation reminder.");
}

const report = {
  schema_version: "1.1",
  caveat: "UTF-8 prompt bytes only; not provider token/cost/latency evidence",
  author_prompt_bytes: bytes(author),
  repository_result: {
    small_result_bytes: smallResultBytes,
    small_prompt_bytes: bytes(smallPrompt),
    small_protocol_overhead_bytes: smallOverhead,
    medium_result_bytes: mediumResultBytes,
    medium_prompt_bytes: bytes(mediumPrompt),
    medium_protocol_overhead_bytes: mediumOverhead,
    initial_schema_tutorial_retransmitted: false,
  },
};

mkdirSync(path.resolve("artifacts"), { recursive: true });
writeFileSync(path.resolve("artifacts", "prompt-footprint.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Prompt footprint PASS ${JSON.stringify(report)}`);
