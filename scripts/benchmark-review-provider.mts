import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexSdkAgentClient } from "../src/agent/codex-sdk-client.js";
import { loadTrustedConfig } from "../src/config/config-loader.js";
import type { AgentLimits } from "../src/config/contracts.js";
import { defaultAgentLimits } from "../src/execution/budget.js";
import { ensureChatGptLogin } from "../src/runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../src/runtime/codex-runtime.js";
import { resolveWcoPaths } from "../src/setup/default-paths.js";
import { parseChatGptCodexAuthority } from "../src/web-bridge/chatgpt-codex-authority.js";
import { chatGptCodexReviewPrompt, chatGptCodexReviewRepositoryResultPrompt } from "../src/web-bridge/chatgpt-codex-prompts.js";
import { prepareChatGptCodexReviewEvidence } from "../src/web-bridge/chatgpt-codex-review-evidence.js";
import { ChatGptCodexSemanticClient } from "../src/web-bridge/chatgpt-codex-semantic-client.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type FinalReviewRequest, type RepositoryCommand, type WebVerdictEnvelope } from "../src/web-bridge/contracts.js";

const MAX_CASE_TURNS = 6;
const MAX_CASE_REPOSITORY_COMMANDS = 5;

type Usage = { turns: number; input_tokens: number; cached_input_tokens: number; output_tokens: number };
type CaseName = "hidden_defect" | "clean_twin";
type VirtualRepository = Record<string, string>;

function addSafe(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(`review provider benchmark ${label} overflowed safe integer accounting.`);
  return value;
}
function measured(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value! < 0) throw new Error(`review provider benchmark ${label} is missing or invalid.`);
  return value!;
}
function sha256(bytes: string | Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function sha1(bytes: Buffer): string { return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex"); }
function exactSourceHead(): string {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("review provider benchmark could not attest an exact Git source head.");
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (dirty) throw new Error("review provider benchmark requires a clean tracked working tree.");
  return head;
}
function parseFlags(args: string[]): { configPath?: string; stateDirectory?: string } {
  let configPath: string | undefined;
  let stateDirectory: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!(flag === "--config" || flag === "--state-dir") || seen.has(flag)) throw new Error("Usage: npm run benchmark:review:provider -- [--config <absolute-config>] [--state-dir <absolute-state-dir>]");
    const value = args[index + 1];
    if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`);
    seen.add(flag);
    if (flag === "--config") configPath = path.resolve(value); else stateDirectory = path.resolve(value);
    index += 1;
  }
  return { ...(configPath ? { configPath } : {}), ...(stateDirectory ? { stateDirectory } : {}) };
}
function entry(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { content_base64: bytes.toString("base64"), sha256: sha256(bytes), size_bytes: bytes.byteLength };
}
function resultFile(filePath: string, text: string, start = 0, end = Buffer.byteLength(text, "utf8")) {
  const full = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > full.byteLength) throw new Error(`review provider benchmark received invalid read region for ${filePath}.`);
  const bytes = full.subarray(start, end);
  return {
    path: filePath,
    content_base64: bytes.toString("base64"),
    content_sha256: sha256(bytes),
    blob_sha: sha1(full),
    size_bytes: bytes.byteLength,
    start_byte: start,
    end_byte_exclusive: end,
    total_bytes: full.byteLength,
  };
}
function executeVirtualRepository(command: RepositoryCommand, repository: VirtualRepository): unknown {
  if (command.operation === "summary") return { repository_id: "review-quality-fixture", base_branch: "main", base_commit: "1".repeat(40), tree_sha: "2".repeat(40) };
  if (command.operation === "tree") {
    const prefix = command.prefix ?? "";
    const all = Object.keys(repository).filter((item) => !prefix || item === prefix || item.startsWith(`${prefix}/`)).sort();
    const maximum = command.maximum_paths ?? all.length;
    return { paths: all.slice(0, maximum), truncated: all.length > maximum };
  }
  if (command.operation === "search") {
    const matches = Object.entries(repository).filter(([, text]) => text.includes(command.query)).map(([filePath]) => filePath).sort();
    const maximum = command.maximum_matches ?? matches.length;
    return { matches: matches.slice(0, maximum), truncated: matches.length > maximum };
  }
  if (command.regions) {
    return {
      files: command.regions.map((region) => {
        const text = repository[region.path];
        if (text === undefined) throw new Error(`review provider benchmark reviewer requested unknown source path ${region.path}.`);
        return resultFile(region.path, text, region.start_byte, region.end_byte_exclusive);
      }),
    };
  }
  return {
    files: command.paths!.map((filePath) => {
      const text = repository[filePath];
      if (text === undefined) throw new Error(`review provider benchmark reviewer requested unknown source path ${filePath}.`);
      const bytes = Buffer.from(text, "utf8");
      return resultFile(filePath, text, 0, bytes.byteLength);
    }),
  };
}

function caseRepository(name: CaseName): VirtualRepository {
  const worker = name === "hidden_defect"
    ? `import { resolveRetryDelay } from "./retry-policy.js";\nexport function run(job: { retryDelayMs?: number }) {\n  const delay = resolveRetryDelay(job.retryDelayMs);\n  if (delay === null) return { status: "retry-disabled" };\n  return { status: "scheduled", delay };\n}\n`
    : `import { resolveRetryDelay } from "./retry-policy.js";\nexport function run(job: { retryDelayMs?: number; retryEnabled?: boolean }) {\n  if (job.retryEnabled === false) return { status: "retry-disabled" };\n  return { status: "scheduled", delay: resolveRetryDelay(job.retryDelayMs) };\n}\n`;
  return {
    "src/retry-policy.ts": `export function resolveRetryDelay(value?: number | null): number {\n  return value ?? 0;\n}\n`,
    "src/worker.ts": worker,
    "tests/retry-policy.test.ts": `import { resolveRetryDelay } from "../src/retry-policy.js";\n// Candidate helper tests pass: omitted delay is now immediate.\nif (resolveRetryDelay(undefined) !== 0) throw new Error("expected immediate retry");\n`,
    "package.json": JSON.stringify({ name: "review-quality-fixture", private: true, type: "module" }, null, 2),
  };
}

function reviewEvidence(request: FinalReviewRequest) {
  const diff = `diff --git a/src/retry-policy.ts b/src/retry-policy.ts\n--- a/src/retry-policy.ts\n+++ b/src/retry-policy.ts\n@@\n-export function resolveRetryDelay(value?: number | null): number | null {\n-  return value ?? null;\n+export function resolveRetryDelay(value?: number | null): number {\n+  return value ?? 0;\n }\n`;
  return prepareChatGptCodexReviewEvidence({
    purpose: "independent_code_review",
    binding: request,
    entries: {
      "repository/diff.patch": entry(diff),
      "task/acceptance.json": entry(JSON.stringify({ criteria: [{ id: "AC-001", description: "Omitted retry delay should resolve to immediate execution without breaking existing retry-disable semantics." }] })),
      "evidence/verification.json": entry(JSON.stringify({ commands: [{ id: "unit", status: "PASS", summary: "resolveRetryDelay helper unit test passes" }] })),
    },
  });
}

async function runCase(options: {
  name: CaseName;
  expectedVerdict: "REVISE" | "APPROVE";
  client: ChatGptCodexSemanticClient;
  profile: any;
  scratchDirectory: string;
  authorityDirectory: string;
  limits: AgentLimits;
}) {
  const reviewId = `provider-review-${options.name}`;
  const request: FinalReviewRequest = {
    run_id: `TASK-PROVIDER-REVIEW:${options.name === "hidden_defect" ? "a" : "b"}`.padEnd(64, options.name === "hidden_defect" ? "a" : "b") + ":" + (options.name === "hidden_defect" ? "c" : "d").repeat(64),
    result_bundle_sha256: (options.name === "hidden_defect" ? "e" : "f").repeat(64),
    published_commit_sha: "1".repeat(40),
    pull_request_url: `https://github.com/example/review-quality/pull/${options.name === "hidden_defect" ? 1 : 2}`,
    review_round: 1,
  };
  const repository = caseRepository(options.name);
  let prompt = chatGptCodexReviewPrompt(request, reviewEvidence(request), reviewId);
  let threadId: string | undefined;
  const usage: Usage = { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let repositoryCommands = 0;
  let exactReads = 0;
  const started = performance.now();

  for (let turn = 0; turn < Math.min(MAX_CASE_TURNS, options.limits.maximum_total_agent_turns); turn += 1) {
    const response = await options.client.turn({
      profile: options.profile,
      prompt,
      scratchDirectory: options.scratchDirectory,
      authorityDirectory: options.authorityDirectory,
      ...(threadId ? { threadId } : {}),
    });
    threadId = response.thread_id;
    usage.turns = addSafe(usage.turns, 1, "turn count");
    usage.input_tokens = addSafe(usage.input_tokens, measured(response.usage.input_tokens, "input tokens"), "input tokens");
    usage.cached_input_tokens = addSafe(usage.cached_input_tokens, measured(response.usage.cached_input_tokens, "cached input tokens"), "cached input tokens");
    usage.output_tokens = addSafe(usage.output_tokens, measured(response.usage.output_tokens, "output tokens"), "output tokens");
    if (usage.input_tokens > options.limits.maximum_total_input_tokens || usage.output_tokens > options.limits.maximum_total_output_tokens) throw new Error(`review provider benchmark ${options.name} exceeded configured token budget.`);

    const authority = parseChatGptCodexAuthority(response.output);
    if (authority.kind === "repository_command") {
      repositoryCommands += 1;
      if (repositoryCommands > MAX_CASE_REPOSITORY_COMMANDS) throw new Error(`review provider benchmark ${options.name} exceeded bounded repository-command budget.`);
      if (authority.value.operation === "read") exactReads += 1;
      const repositoryResult = executeVirtualRepository(authority.value, repository);
      prompt = chatGptCodexReviewRepositoryResultPrompt(repositoryResult, request, reviewId);
      continue;
    }
    if (authority.kind !== "web_verdict") throw new Error(`review provider benchmark ${options.name} returned invalid review authority ${authority.kind}.`);
    const verdict = authority.value as WebVerdictEnvelope;
    if (verdict.review_id !== reviewId || verdict.run_id !== request.run_id || verdict.result_bundle_sha256 !== request.result_bundle_sha256) throw new Error(`review provider benchmark ${options.name} returned stale/mismatched verdict binding.`);
    if (exactReads < 1) throw new Error(`review provider benchmark ${options.name} reached verdict without an exact source read.`);
    if (verdict.verdict !== options.expectedVerdict) throw new Error(`review provider benchmark ${options.name} expected ${options.expectedVerdict} but provider returned ${verdict.verdict}: ${verdict.summary}`);
    if (options.name === "hidden_defect") {
      const findingText = verdict.findings.map((finding) => `${finding.description}`).join(" ");
      if (!/(retry|disable|caller|worker|null|schedule)/i.test(`${verdict.summary} ${findingText}`)) throw new Error("review provider benchmark hidden defect verdict did not identify the caller/retry invariant conflict.");
    } else if (verdict.findings.some((finding) => finding.severity === "blocking")) {
      throw new Error("review provider benchmark clean twin produced a blocking false positive.");
    }
    return {
      case: options.name,
      expected_verdict: options.expectedVerdict,
      observed_verdict: verdict.verdict,
      provider_turns: usage.turns,
      repository_commands: repositoryCommands,
      exact_source_reads: exactReads,
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      duration_ms: Math.ceil(performance.now() - started),
      summary: verdict.summary,
      findings: verdict.findings,
    };
  }
  throw new Error(`review provider benchmark ${options.name} did not converge within ${MAX_CASE_TURNS} provider turns.`);
}

const sourceHead = exactSourceHead();
const flags = parseFlags(process.argv.slice(2));
const paths = resolveWcoPaths({ ...(flags.configPath ? { configPath: flags.configPath } : {}), ...(flags.stateDirectory ? { stateDirectory: flags.stateDirectory } : {}) });
const config = await loadTrustedConfig(paths.config);
const profile = config.agents?.final_reviewer;
if (!profile) throw new Error("Review provider benchmark requires configured final_reviewer profile.");
const limits = config.agents?.limits ?? defaultAgentLimits();
if (limits.maximum_total_agent_turns < 2) throw new Error("Review provider benchmark requires at least two configured provider turns per case.");
const authorized = await ensureChatGptLogin({ config, stateDirectory: paths.state });
if (!authorized) throw new Error("ChatGPT authorization is required. Run `wco web connect` in an interactive terminal, then retry the review provider benchmark.");
const runtime = await resolveCodexRuntime(config.runtime, paths.state);
const raw = new CodexSdkAgentClient(runtime);
await raw.checkAvailability();
const client = new ChatGptCodexSemanticClient(raw, limits.maximum_turn_seconds);
const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-provider-benchmark-"));
const scratchDirectory = path.join(root, "scratch");
const authorityDirectory = path.join(root, "authority");
await mkdir(scratchDirectory, { mode: 0o700 });
await mkdir(authorityDirectory, { mode: 0o700 });

const hidden = await runCase({ name: "hidden_defect", expectedVerdict: "REVISE", client, profile, scratchDirectory, authorityDirectory, limits });
const clean = await runCase({ name: "clean_twin", expectedVerdict: "APPROVE", client, profile, scratchDirectory, authorityDirectory, limits });
const artifact = {
  benchmark_version: "1.0",
  kind: "independent-review-provider-qualification",
  provider: "local-chatgpt-codex",
  source_head: sourceHead,
  codex_runtime_version: runtime.package_version,
  model: profile.model,
  reasoning_effort: profile.reasoning_effort,
  hidden_defect_must_revise: true,
  clean_twin_must_approve: true,
  exact_source_read_required_before_verdict: true,
  cases: [hidden, clean],
  totals: {
    provider_turns: hidden.provider_turns + clean.provider_turns,
    repository_commands: hidden.repository_commands + clean.repository_commands,
    exact_source_reads: hidden.exact_source_reads + clean.exact_source_reads,
    input_tokens: hidden.input_tokens + clean.input_tokens,
    cached_input_tokens: hidden.cached_input_tokens + clean.cached_input_tokens,
    output_tokens: hidden.output_tokens + clean.output_tokens,
    duration_ms: hidden.duration_ms + clean.duration_ms,
  },
  caveat: "This measures the configured real provider on two bounded review cases. It reduces false-approval risk; it cannot prove arbitrary future tasks are bug-free.",
};
await mkdir(path.resolve("artifacts"), { recursive: true });
await writeFile(path.resolve("artifacts/review-provider-qualification.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
