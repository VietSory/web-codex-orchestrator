import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import {
  compareSemanticBenchmarkArms,
  evaluateSemanticBenchmarkArm,
  type SemanticBenchmarkArmResult,
} from "../src/benchmark/semantic-challenge-evaluation.js";
import { parseSemanticBenchmarkCorpus } from "../src/benchmark/semantic-corpus.js";
import { loadTrustedConfig } from "../src/config/config-loader.js";
import type { AgentLimits, AgentProfile } from "../src/config/contracts.js";
import { defaultAgentLimits } from "../src/execution/budget.js";
import { ensureChatGptLogin } from "../src/runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { resolveWcoPaths } from "../src/setup/default-paths.js";
import { MAINTAINER_AUTHORING_STANDARD, MAINTAINER_REVIEW_STANDARD } from "../src/shared/maintainer-reasoning-standard.js";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "kind", "case_id", "selected_ids"],
  properties: {
    schema_version: { type: "string", const: "1.0" },
    kind: { type: "string", const: "semantic-benchmark-selection" },
    case_id: { type: "string", minLength: 3, maxLength: 64 },
    selected_ids: {
      type: "array",
      maxItems: 128,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9_-]{1,63}$" },
    },
  },
} as const;

interface UsageTotals {
  turns: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

function addSafe(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(`semantic provider benchmark ${label} overflowed safe integer accounting.`);
  return value;
}

function measured(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value! < 0) throw new Error(`semantic provider benchmark ${label} usage is missing or invalid.`);
  return value!;
}

class ProviderBenchmarkBudget {
  readonly usage: UsageTotals = { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  private readonly startedAt = Date.now();

  constructor(private readonly limits: AgentLimits) {}

  beforeTurn(): void {
    if (this.usage.turns >= this.limits.maximum_total_agent_turns) throw new Error("semantic provider benchmark configured turn budget is exhausted.");
    if ((Date.now() - this.startedAt) / 1000 >= this.limits.maximum_total_seconds) throw new Error("semantic provider benchmark configured wall-clock budget is exhausted.");
  }

  record(input: number, cached: number, output: number): void {
    if (cached > input) throw new Error("semantic provider benchmark cached input usage exceeds total input usage.");
    this.usage.turns = addSafe(this.usage.turns, 1, "turn count");
    this.usage.input_tokens = addSafe(this.usage.input_tokens, input, "input tokens");
    this.usage.cached_input_tokens = addSafe(this.usage.cached_input_tokens, cached, "cached input tokens");
    this.usage.output_tokens = addSafe(this.usage.output_tokens, output, "output tokens");
    if (this.usage.input_tokens > this.limits.maximum_total_input_tokens || this.usage.output_tokens > this.limits.maximum_total_output_tokens) {
      throw new Error("semantic provider benchmark configured token budget is exhausted.");
    }
  }
}

function armPolicy(arm: "author_style" | "independent_challenger"): string {
  if (arm === "author_style") {
    return [
      MAINTAINER_AUTHORING_STANDARD,
      "Benchmark role: behave like the primary Web-A semantic author deciding which available evidence is materially required before implementation authority could be sealed.",
      "Do not assume another reviewer will correct omissions later.",
    ].join("\n");
  }
  return [
    MAINTAINER_REVIEW_STANDARD,
    "Benchmark role: behave like an independent Web-B challenger with no access to Web-A's candidate answer.",
    "Re-derive the needed understanding from the public evidence catalog, challenge tempting distractors, and reject unsupported assumptions independently.",
  ].join("\n");
}

function parseFlags(args: string[]): { configPath?: string; stateDirectory?: string } {
  let configPath: string | undefined;
  let stateDirectory: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!(flag === "--config" || flag === "--state-dir") || seen.has(flag)) throw new Error("Usage: npm run benchmark:semantic:provider -- [--config <absolute-config>] [--state-dir <absolute-state-dir>]");
    const value = args[index + 1];
    if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`);
    seen.add(flag);
    if (flag === "--config") configPath = path.resolve(value);
    else stateDirectory = path.resolve(value);
    index += 1;
  }
  return { ...(configPath ? { configPath } : {}), ...(stateDirectory ? { stateDirectory } : {}) };
}

async function runArm(options: {
  arm: "author_style" | "independent_challenger";
  profile: AgentProfile;
  client: CodexSdkAgentClient;
  corpus: ReturnType<typeof parseSemanticBenchmarkCorpus>;
  scratchDirectory: string;
  authorityDirectory: string;
  budget: ProviderBenchmarkBudget;
}): Promise<{ result: SemanticBenchmarkArmResult; usage: UsageTotals }> {
  const usage: UsageTotals = { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const policy = armPolicy(options.arm);
  const result = await evaluateSemanticBenchmarkArm({
    arm: options.arm,
    corpus: options.corpus,
    provider: async ({ prompt }) => {
      options.budget.beforeTurn();
      const response = await options.client.turn({
        role: "final_reviewer",
        model: options.profile.model,
        reasoning_effort: options.profile.reasoning_effort,
        prompt: `${policy}\n\n${prompt}`,
        output_schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        read_only: true,
        approval_policy: "never",
        sandbox_mode: "read-only",
        network_access: false,
        live_web_search: false,
        cached_web_search: false,
        workspace_path: options.scratchDirectory,
        accepted_bundle_path: options.authorityDirectory,
      });
      const input = measured(response.usage?.input_tokens, "input-token");
      const cached = measured(response.usage?.cached_input_tokens, "cached-input-token");
      const output = measured(response.usage?.output_tokens, "output-token");
      options.budget.record(input, cached, output);
      usage.turns = addSafe(usage.turns, 1, "arm turn count");
      usage.input_tokens = addSafe(usage.input_tokens, input, "arm input tokens");
      usage.cached_input_tokens = addSafe(usage.cached_input_tokens, cached, "arm cached input tokens");
      usage.output_tokens = addSafe(usage.output_tokens, output, "arm output tokens");
      return response.output;
    },
  });
  if (usage.turns !== options.corpus.cases.length || result.provider_turns !== options.corpus.cases.length) throw new Error("semantic provider benchmark did not execute exactly one provider turn per case.");
  return { result, usage };
}

const flags = parseFlags(process.argv.slice(2));
const paths = resolveWcoPaths({ ...(flags.configPath ? { configPath: flags.configPath } : {}), ...(flags.stateDirectory ? { stateDirectory: flags.stateDirectory } : {}) });
const config = await loadTrustedConfig(paths.config);
const profile = config.agents?.final_reviewer;
if (!profile) throw new Error("Semantic provider benchmark requires the configured final_reviewer profile.");
const limits = config.agents?.limits ?? defaultAgentLimits();

const corpusPath = path.resolve("tests/fixtures/semantic-understanding/cases.json");
const corpusBytes = await readFile(corpusPath);
const corpusSha256 = crypto.createHash("sha256").update(corpusBytes).digest("hex");
const corpus = parseSemanticBenchmarkCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
const requiredTurns = corpus.cases.length * 2;
if (limits.maximum_total_agent_turns < requiredTurns) {
  throw new Error(`Semantic provider benchmark requires ${requiredTurns} provider turns for two equal arms, but configured maximum_total_agent_turns is ${limits.maximum_total_agent_turns}.`);
}
const budget = new ProviderBenchmarkBudget(limits);

const authorized = await ensureChatGptLogin({ config, stateDirectory: paths.state });
if (!authorized) throw new Error("ChatGPT authorization is required. Run `wco web connect` in an interactive terminal, then retry the semantic provider benchmark.");

const runtime = await resolveCodexRuntime(config.runtime, paths.state);
const client = new CodexSdkAgentClient(runtime);
await client.checkAvailability();

const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-provider-benchmark-"));
const scratchDirectory = path.join(root, "scratch");
const authorityDirectory = path.join(root, "authority");
await mkdir(scratchDirectory, { mode: 0o700 });
await mkdir(authorityDirectory, { mode: 0o700 });

try {
  const author = await runArm({ arm: "author_style", profile, client, corpus, scratchDirectory, authorityDirectory, budget });
  const challenger = await runArm({ arm: "independent_challenger", profile, client, corpus, scratchDirectory, authorityDirectory, budget });
  const comparison = compareSemanticBenchmarkArms(author.result, challenger.result);
  console.log(JSON.stringify({
    benchmark_version: "1.0",
    kind: "semantic-provider-ab",
    provider: "local-chatgpt-codex",
    codex_runtime_version: runtime.package_version,
    model: profile.model,
    reasoning_effort: profile.reasoning_effort,
    corpus_cases: corpus.cases.length,
    corpus_sha256: corpusSha256,
    arm_order: ["author_style", "independent_challenger"],
    samples_per_case_per_arm: 1,
    total_provider_turns: budget.usage.turns,
    hidden_gold_exposed_to_provider: false,
    lifecycle_mutation: false,
    total_usage: budget.usage,
    arms: {
      author_style: { ...author.result, usage: author.usage },
      independent_challenger: { ...challenger.result, usage: challenger.usage },
    },
    comparison,
    interpretation: "Provider-backed policy A/B on the same public semantic corpus. One sample per case/arm measures directional independent semantic-selection quality; it does not prove end-to-end task completion or production authority uplift.",
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
