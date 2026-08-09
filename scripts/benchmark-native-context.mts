import path from "node:path";
import { performance } from "node:perf_hooks";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import { reviewWithSol } from "../src/agent/sol-reviewer.js";
import { reviewWithTerra } from "../src/agent/terra-reviewer.js";
import { runContextAbBenchmark } from "../src/benchmark/context-ab.js";
import { loadPhase4Config } from "../src/execution/execution-config.js";
import { reviewPrompt } from "../src/executor/production-gates.js";
import { selectSmartContext } from "../src/executor/smart-context.js";
import { attestReadyExecutorSnapshot } from "../src/orchestration/executor-ready.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";

interface Arguments {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  configPath: string;
  reviewer: "terra" | "sol";
  repetitions: number;
}

function usageText(): string {
  return "Usage: npm run benchmark:native:context -- --run-id <run-id> --artifact-sha <sha256> --state-dir <dir> --config <config.json> --reviewer <terra|sol> [--repetitions <1-5>]";
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--") || values.has(key)) throw new Error(`Unexpected or duplicate argument '${key}'.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Argument '${key}' requires a value.`);
    if (!["--run-id", "--artifact-sha", "--state-dir", "--config", "--reviewer", "--repetitions"].includes(key)) throw new Error(`Unknown argument '${key}'.`);
    values.set(key, value);
    index += 1;
  }
  const required = (key: string, env?: string): string => {
    const value = values.get(key) ?? env;
    if (!value) throw new Error(`Missing '${key}'.`);
    return value;
  };
  const runId = required("--run-id", process.env.WCO_RUN_ID);
  const artifactSha256 = required("--artifact-sha");
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error("--artifact-sha must be a lowercase SHA-256.");
  const reviewer = required("--reviewer");
  if (reviewer !== "terra" && reviewer !== "sol") throw new Error("--reviewer must be terra or sol.");
  const repetitions = Number(values.get("--repetitions") ?? "2");
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("--repetitions must be 1..5.");
  return {
    runId,
    artifactSha256,
    stateDirectory: path.resolve(required("--state-dir", process.env.WCO_STATE_DIR)),
    configPath: path.resolve(required("--config", process.env.WCO_CONFIG)),
    reviewer,
    repetitions,
  };
}

function safeUsage(response: { usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }): { input_tokens: number; cached_input_tokens: number; output_tokens: number } {
  const usage = response.usage;
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens! < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens! < 0) {
    throw new Error("Provider input/output token usage is unavailable; benchmark result would be misleading.");
  }
  const cached = usage.cached_input_tokens ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0) throw new Error("Provider cached-input token usage is invalid.");
  return { input_tokens: usage.input_tokens!, cached_input_tokens: cached, output_tokens: usage.output_tokens! };
}

const args = (() => {
  try { return parseArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usageText());
    process.exit(2);
  }
})();

if (process.env.WCO_RUN_CODEX_BENCHMARK !== "1") {
  console.error("Native model benchmark is opt-in because it starts paid/provider-backed Codex review turns. Set WCO_RUN_CODEX_BENCHMARK=1 explicitly.");
  process.exit(2);
}

const initial = await attestReadyExecutorSnapshot({
  runId: args.runId,
  artifactSha256: args.artifactSha256,
  stateDirectory: args.stateDirectory,
  configPath: args.configPath,
});
const config = await loadPhase4Config(args.configPath);
const runtime = await resolveCodexRuntime(config.runtime, args.stateDirectory);
const client = new CodexSdkAgentClient(runtime);
await client.checkAvailability();

const selection = selectSmartContext(initial.source.pack, initial.changedPaths);
const baseRequest = {
  run_id: args.runId,
  artifact_sha256: args.artifactSha256,
  worktree_path: initial.receipt.worktree_path,
  accepted_bundle_path: initial.source.trusted.runReceipt.accepted_bundle_path,
  change_set_digest: initial.changeSetDigest,
  changed_paths: initial.changedPaths,
  reviewer: args.reviewer,
  prior_evidence_sha256: [],
  context_selection: selection,
} as const;
const profile = args.reviewer === "terra" ? config.agents.internal_reviewer : config.agents.final_reviewer;

console.error(`WCO native context A/B benchmark: ${args.repetitions * 2} read-only ${args.reviewer} model turns on exact digest ${initial.changeSetDigest}.`);

const report = await runContextAbBenchmark({
  repetitions: args.repetitions,
  expectedChangeSetSha256: initial.changeSetDigest,
  beforeSample: async () => {
    const fresh = await attestReadyExecutorSnapshot({
      runId: args.runId,
      artifactSha256: args.artifactSha256,
      stateDirectory: args.stateDirectory,
      configPath: args.configPath,
    });
    if (fresh.changeSetDigest !== initial.changeSetDigest || fresh.receipt.worktree_path !== initial.receipt.worktree_path || fresh.changedPaths.join("\n") !== initial.changedPaths.join("\n")) {
      throw new Error("Exact READY snapshot drifted during benchmark; refusing to compare different code states.");
    }
  },
  runSample: async (arm) => {
    const prompt = reviewPrompt(baseRequest, { smart_context: arm === "smart" });
    const started = performance.now();
    const result = args.reviewer === "terra"
      ? await reviewWithTerra(client, {
          model: profile.model,
          reasoning_effort: profile.reasoning_effort,
          prompt,
          threadId: undefined,
          workspacePath: initial.receipt.worktree_path,
          acceptedBundlePath: initial.source.trusted.runReceipt.accepted_bundle_path,
        })
      : await reviewWithSol(client, {
          model: profile.model,
          reasoning_effort: profile.reasoning_effort,
          prompt,
          threadId: undefined,
          workspacePath: initial.receipt.worktree_path,
          acceptedBundlePath: initial.source.trusted.runReceipt.accepted_bundle_path,
        });
    const elapsed = performance.now() - started;
    const after = await attestReadyExecutorSnapshot({
      runId: args.runId,
      artifactSha256: args.artifactSha256,
      stateDirectory: args.stateDirectory,
      configPath: args.configPath,
    });
    if (after.changeSetDigest !== initial.changeSetDigest) throw new Error("Read-only benchmark changed or observed drift in the exact snapshot.");
    return {
      elapsed_ms: elapsed,
      verdict: result.review.verdict,
      reviewed_change_set_sha256: result.review.reviewed_change_set_sha256,
      usage: safeUsage(result.response),
    };
  },
});

console.log(JSON.stringify({
  benchmark_version: "1.0",
  generated_at: new Date().toISOString(),
  run_id: args.runId,
  artifact_sha256: args.artifactSha256,
  reviewer: args.reviewer,
  model: profile.model,
  reasoning_effort: profile.reasoning_effort,
  smart_context_selection_sha256: selection.selection_sha256,
  smart_context_selected_paths: selection.paths.length,
  lifecycle_mutation: false,
  report,
  note: "This opt-in benchmark performs real read-only Codex review turns. Compare provider-reported tokens, latency, and exact-digest APPROVE rate; the benchmark does not mutate WCO lifecycle receipts.",
}, null, 2));
