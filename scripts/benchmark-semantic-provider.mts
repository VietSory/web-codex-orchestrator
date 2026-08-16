import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import {
  compareSemanticBenchmarkArms,
  evaluateSemanticBenchmarkPaired,
  type SemanticBenchmarkProvider,
} from "../src/benchmark/semantic-challenge-evaluation.js";
import { parseSemanticBenchmarkCorpus } from "../src/benchmark/semantic-corpus.js";
import { assertPromptOnlySemanticBenchmarkTurn } from "../src/benchmark/semantic-provider-event-policy.js";
import { qualifySemanticProviderBenchmark } from "../src/benchmark/semantic-provider-qualification.js";
import { loadTrustedConfig } from "../src/config/config-loader.js";
import type { AgentLimits, AgentProfile } from "../src/config/contracts.js";
import { defaultAgentLimits } from "../src/execution/budget.js";
import { createSemanticChallengeRequest, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";
import { ensureChatGptLogin } from "../src/runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { resolveWcoPaths } from "../src/setup/default-paths.js";
import { MAINTAINER_AUTHORING_STANDARD } from "../src/shared/maintainer-reasoning-standard.js";

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

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactSourceHead(): string {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("semantic provider benchmark could not attest an exact Git source head.");
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (dirty.length > 0) throw new Error("semantic provider benchmark requires a clean tracked working tree so its source head is reproducible.");
  return head;
}

async function assertEmptyCanonicalDirectory(target: string, label: string): Promise<string> {
  const absolute = path.resolve(target);
  const info = await lstat(absolute).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`semantic provider benchmark ${label} directory is unsafe.`);
  const directory = await opendir(absolute);
  try {
    if (await directory.read()) throw new Error(`semantic provider benchmark ${label} directory must remain empty.`);
  } finally {
    await directory.close().catch(() => undefined);
  }
  return absolute;
}

async function assertBenchmarkFilesystem(scratchDirectory: string, authorityDirectory: string): Promise<void> {
  const scratch = path.resolve(scratchDirectory);
  const authority = path.resolve(authorityDirectory);
  if (scratch === authority || scratch.startsWith(`${authority}${path.sep}`) || authority.startsWith(`${scratch}${path.sep}`)) {
    throw new Error("semantic provider benchmark filesystem roots must be independent.");
  }
  await assertEmptyCanonicalDirectory(scratch, "scratch");
  await assertEmptyCanonicalDirectory(authority, "authority");
}

class ProviderBenchmarkBudget {
  readonly usage: UsageTotals = { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  private readonly startedAt = performance.now();

  constructor(private readonly limits: AgentLimits) {}

  turnSignal(): AbortSignal {
    if (this.usage.turns >= this.limits.maximum_total_agent_turns) throw new Error("semantic provider benchmark configured turn budget is exhausted.");
    const elapsedMs = performance.now() - this.startedAt;
    const totalMs = this.limits.maximum_total_seconds * 1_000;
    const remainingTotalMs = totalMs - elapsedMs;
    if (!Number.isFinite(remainingTotalMs) || remainingTotalMs <= 0) throw new Error("semantic provider benchmark configured wall-clock budget is exhausted.");
    const configuredTurnMs = this.limits.maximum_turn_seconds * 1_000;
    const turnMs = Math.max(1, Math.floor(Math.min(configuredTurnMs, remainingTotalMs)));
    return AbortSignal.timeout(turnMs);
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

function runtimeBlindChallengerPolicy(): string {
  const probe = createSemanticChallengeRequest({
    challengeId: "benchmark-policy-probe",
    repository: { repository_id: "benchmark-policy-probe", base_branch: "main", base_commit: "0".repeat(40) },
    originalGoal: "Benchmark policy probe only.",
  });
  const runtimeLines = semanticChallengePrompt(probe).split("\n");
  const prefixes = [
    "You are an independent senior-maintainer semantic challenger.",
    "You have intentionally NOT been shown Web-A's candidate contract",
    "Your task is to independently determine what the repository currently does",
    "Trace relevant callers/callees and state/authority boundaries",
    "Challenge unsupported assumptions.",
  ];
  const selected = prefixes.map((prefix) => runtimeLines.find((line) => line.startsWith(prefix)));
  if (selected.some((line) => !line)) throw new Error("semantic provider benchmark could not derive the exact runtime blind-challenger reasoning policy.");
  return (selected as string[]).join("\n");
}

function armPolicy(arm: "author_style" | "independent_challenger"): string {
  const promptOnly = "Benchmark isolation: use only the public benchmark case in this prompt. Do not inspect the filesystem, shell, repository, environment, network, or any external source; do not attempt to discover hidden benchmark truth.";
  if (arm === "author_style") {
    return [
      MAINTAINER_AUTHORING_STANDARD,
      promptOnly,
      "Benchmark role: behave like the primary Web-A semantic author deciding which available evidence is materially required before implementation authority could be sealed.",
      "Do not assume another reviewer will correct omissions later.",
    ].join("\n");
  }
  return [
    runtimeBlindChallengerPolicy(),
    promptOnly,
    "Benchmark adaptation: the complete public evidence catalog replaces repository_command exploration for this one-turn selection task. Do not request repository actions.",
    "Select independently; you have no access to Web-A's candidate selection.",
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

function createArmProvider(options: {
  arm: "author_style" | "independent_challenger";
  profile: AgentProfile;
  client: CodexSdkAgentClient;
  scratchDirectory: string;
  authorityDirectory: string;
  budget: ProviderBenchmarkBudget;
  observedThreadIds: Set<string>;
}): { provider: SemanticBenchmarkProvider; usage: UsageTotals; policy_sha256: string } {
  const usage: UsageTotals = { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  const policy = armPolicy(options.arm);
  const provider: SemanticBenchmarkProvider = async ({ prompt }) => {
    await assertBenchmarkFilesystem(options.scratchDirectory, options.authorityDirectory);
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
      signal: options.budget.turnSignal(),
    });
    assertPromptOnlySemanticBenchmarkTurn(response.public_events);
    if (!response.thread_id || options.observedThreadIds.has(response.thread_id)) throw new Error("semantic provider benchmark requires one fresh provider thread per arm/case turn.");
    options.observedThreadIds.add(response.thread_id);
    const input = measured(response.usage?.input_tokens, "input-token");
    const cached = measured(response.usage?.cached_input_tokens, "cached-input-token");
    const output = measured(response.usage?.output_tokens, "output-token");
    options.budget.record(input, cached, output);
    usage.turns = addSafe(usage.turns, 1, "arm turn count");
    usage.input_tokens = addSafe(usage.input_tokens, input, "arm input tokens");
    usage.cached_input_tokens = addSafe(usage.cached_input_tokens, cached, "arm cached input tokens");
    usage.output_tokens = addSafe(usage.output_tokens, output, "arm output tokens");
    return response.output;
  };
  return { provider, usage, policy_sha256: sha256(policy) };
}

const sourceHead = exactSourceHead();
const flags = parseFlags(process.argv.slice(2));
const paths = resolveWcoPaths({ ...(flags.configPath ? { configPath: flags.configPath } : {}), ...(flags.stateDirectory ? { stateDirectory: flags.stateDirectory } : {}) });
const config = await loadTrustedConfig(paths.config);
const profile = config.agents?.final_reviewer;
if (!profile) throw new Error("Semantic provider benchmark requires the configured final_reviewer profile.");
const limits = config.agents?.limits ?? defaultAgentLimits();

const corpusPath = path.resolve("tests/fixtures/semantic-understanding/cases.json");
const corpusBytes = await readFile(corpusPath);
const corpusSha256 = sha256(corpusBytes);
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
const authorRoot = path.join(root, "author-style");
const challengerRoot = path.join(root, "independent-challenger");
await mkdir(authorRoot, { mode: 0o700 });
await mkdir(challengerRoot, { mode: 0o700 });
const authorScratch = path.join(authorRoot, "scratch");
const authorAuthority = path.join(authorRoot, "authority");
const challengerScratch = path.join(challengerRoot, "scratch");
const challengerAuthority = path.join(challengerRoot, "authority");
for (const directory of [authorScratch, authorAuthority, challengerScratch, challengerAuthority]) await mkdir(directory, { mode: 0o700 });

try {
  const observedThreadIds = new Set<string>();
  const author = createArmProvider({ arm: "author_style", profile, client, scratchDirectory: authorScratch, authorityDirectory: authorAuthority, budget, observedThreadIds });
  const challenger = createArmProvider({ arm: "independent_challenger", profile, client, scratchDirectory: challengerScratch, authorityDirectory: challengerAuthority, budget, observedThreadIds });
  const paired = await evaluateSemanticBenchmarkPaired({
    baseline_arm: "author_style",
    challenger_arm: "independent_challenger",
    corpus,
    baseline_provider: author.provider,
    challenger_provider: challenger.provider,
  });
  if (author.usage.turns !== corpus.cases.length || challenger.usage.turns !== corpus.cases.length
    || paired.baseline.provider_turns !== corpus.cases.length || paired.challenger.provider_turns !== corpus.cases.length) {
    throw new Error("semantic provider benchmark did not execute exactly one fresh provider turn per case and arm.");
  }
  const comparison = compareSemanticBenchmarkArms(paired.baseline, paired.challenger);
  const qualification = qualifySemanticProviderBenchmark({
    baseline: paired.baseline,
    challenger: paired.challenger,
    comparison,
    baseline_usage: author.usage,
    challenger_usage: challenger.usage,
  });
  console.log(JSON.stringify({
    benchmark_version: "1.3",
    kind: "semantic-provider-ab",
    provider: "local-chatgpt-codex",
    source_head: sourceHead,
    codex_runtime_version: runtime.package_version,
    model: profile.model,
    reasoning_effort: profile.reasoning_effort,
    corpus_cases: corpus.cases.length,
    corpus_sha256: corpusSha256,
    execution_order: paired.execution_order,
    pairing: "case-paired_alternating-first-arm",
    samples_per_case_per_arm: 1,
    fresh_provider_thread_per_turn: true,
    total_provider_turns: budget.usage.turns,
    hidden_gold_in_prompt: false,
    provider_local_tool_activity: "rejected_if_observed_or_event_audit_truncated",
    provider_filesystem_context: "separate_empty_disjoint_temporary_roots_per_arm",
    challenger_policy_source: "runtime_semanticChallengePrompt_core",
    lifecycle_mutation: false,
    total_usage: budget.usage,
    arms: {
      author_style: { ...paired.baseline, usage: author.usage, policy_sha256: author.policy_sha256 },
      independent_challenger: { ...paired.challenger, usage: challenger.usage, policy_sha256: challenger.policy_sha256 },
    },
    comparison,
    qualification,
    interpretation: "Provider-backed paired policy A/B on the same public semantic corpus. Case order alternates which arm runs first to reduce time/load/cache confounding. The challenger arm derives its maintainer reasoning text from the runtime blind-challenge prompt. Accepted turns contain no observed Codex local/external tool events and fail closed if the bounded public event audit could be truncated. Release qualification rejects newly introduced critical misses, aggregate critical-recall or weighted-quality regression, and extra provider-token cost without any measured semantic gain. One fresh provider thread per case/arm remains directional semantic-selection evidence; it does not prove end-to-end task completion or production authority uplift.",
  }, null, 2));
  if (!qualification.pass) {
    throw new Error(`Semantic provider benchmark qualification failed: ${qualification.reasons.join(", ")}.`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
