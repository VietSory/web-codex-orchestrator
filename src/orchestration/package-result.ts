import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { readStableExecutorStateFile } from "../executor/state-io.js";
import { GitRunner as SecureGitRunner } from "../git/git-runner.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import type { GitRunner } from "../result-bundle/git-evidence-reader.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS, type ResultBundleReceipt, type ResultBundleLimits } from "../result-bundle/contracts.js";
import { packageResultBundle } from "../result-bundle/result-bundle-service.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { OrchestrationError } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { prepareOrchestrationDirectory } from "./ledger.js";

const MAX_EXECUTOR_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTOR_EVIDENCE_BYTES = 512 * 1024;

async function prepareResultGitRuntime(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory, "orchestration", "result-git-runtime");
  await prepareOrchestrationDirectory(stateDirectory, runtime);

  const hooks = path.join(runtime, "empty-hooks");
  await fs.mkdir(hooks, { mode: 0o700 }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const hooksStat = await fs.lstat(hooks);
  if (hooksStat.isSymbolicLink() || !hooksStat.isDirectory() || await fs.realpath(hooks) !== hooks) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_GIT_FAILED", "Result Bundle Git hooks directory is unsafe.");
  }

  const emptyConfig = path.join(runtime, "empty-config");
  try {
    await fs.writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const configStat = await fs.lstat(emptyConfig);
    if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.size !== 0) {
      throw new OrchestrationError("ORCHESTRATION_RESULT_GIT_FAILED", "Result Bundle empty Git config is unsafe.");
    }
  }
  return runtime;
}

async function createGitRunner(stateDirectory: string, limits: ResultBundleLimits): Promise<GitRunner> {
  const runtime = await prepareResultGitRuntime(stateDirectory);
  const maximumEvidenceBytes = Math.max(limits.maximum_diff_bytes, limits.maximum_source_file_bytes) + 1;
  return new SecureGitRunner(process.env, runtime, undefined, {
    stdoutMaxBytes: maximumEvidenceBytes,
    stderrMaxBytes: Math.min(1_048_576, maximumEvidenceBytes),
  });
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function tokenCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `Executor review evidence has invalid ${label}.`);
  }
  return value as number;
}

async function readReviewUsage(options: {
  executorDirectory: string;
  reviewer: "terra" | "sol";
  round: number;
  evidenceSha256: string | null;
}): Promise<{ input_tokens: number; cached_input_tokens: number; output_tokens: number }> {
  if (options.evidenceSha256 === null || options.round < 1) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `${options.reviewer} approval lacks immutable evidence identity.`);
  }
  const evidencePath = path.join(
    options.executorDirectory,
    "evidence",
    `${options.reviewer}-${options.round}-${options.evidenceSha256}.json`,
  );
  const bytes = await readStableExecutorStateFile(evidencePath, MAX_EXECUTOR_EVIDENCE_BYTES);
  if (sha256(bytes) !== options.evidenceSha256) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `${options.reviewer} evidence changed after executor attestation.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `${options.reviewer} evidence is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `${options.reviewer} evidence must be an object.`);
  }
  const usage = (parsed as Record<string, unknown>).usage;
  if (usage === null || usage === undefined) {
    return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  }
  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", `${options.reviewer} evidence usage must be an object or null.`);
  }
  const record = usage as Record<string, unknown>;
  return {
    input_tokens: record.input_tokens === undefined ? 0 : tokenCounter(record.input_tokens, `${options.reviewer}.input_tokens`),
    cached_input_tokens: record.cached_input_tokens === undefined ? 0 : tokenCounter(record.cached_input_tokens, `${options.reviewer}.cached_input_tokens`),
    output_tokens: record.output_tokens === undefined ? 0 : tokenCounter(record.output_tokens, `${options.reviewer}.output_tokens`),
  };
}

export async function packageResultForRun(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<ResultBundleReceipt> {
  const config = await loadTrustedConfig(options.configPath);
  const github = config.github_pull_request;
  if (!github) throw new OrchestrationError("ORCHESTRATION_RESULT_CONFIG_INVALID", "github_pull_request config is required to package a Result Bundle.");
  if (!config.agents) throw new OrchestrationError("ORCHESTRATION_RESULT_CONFIG_INVALID", "agent profiles are required to project executor review evidence into the Result Bundle.");

  const tokenKey = github.authentication.token_environment_key;
  const token = process.env[tokenKey];
  if (!token) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTH_UNAVAILABLE", `GitHub token not found at configured environment key ${tokenKey}.`);

  const selected = await readSelectedArtifact(options.stateDirectory, options.runId);
  if (!selected) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "Result packaging requires the currently selected registered Web artifact.");
  const ready = await attestReadyExecutorSnapshot({
    runId: options.runId,
    artifactSha256: selected.artifact_sha256,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
  });
  const executor = ready.receipt;
  const run = ready.source.trusted.runReceipt;
  if (executor.change_set_digest === null || executor.change_set_digest !== ready.changeSetDigest) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "READY executor receipt lost its exact change-set binding before Result packaging.");
  }

  const executorReceiptPath = path.join(ready.executorDirectory, "executor-receipt.json");
  const executorReceiptBytes = await readStableExecutorStateFile(executorReceiptPath, MAX_EXECUTOR_RECEIPT_BYTES);
  const canonicalExecutorReceipt = canonicalJsonBuffer(executor);
  if (!executorReceiptBytes.equals(canonicalExecutorReceipt)) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Executor receipt changed after the READY snapshot was attested.");
  }

  const [terraUsage, solUsage] = await Promise.all([
    readReviewUsage({
      executorDirectory: ready.executorDirectory,
      reviewer: "terra",
      round: executor.terra_review.rounds,
      evidenceSha256: executor.terra_review.evidence_sha256,
    }),
    readReviewUsage({
      executorDirectory: ready.executorDirectory,
      reviewer: "sol",
      round: executor.sol_review.rounds,
      evidenceSha256: executor.sol_review.evidence_sha256,
    }),
  ]);

  const executionEvidence: Record<string, unknown> = {
    execution_version: "1.0",
    run_id: options.runId,
    state: "READY_FOR_PUBLISH",
    base_commit: run.base_commit,
    base_branch: run.base_branch,
    branch_name: run.branch_name,
    worktree_path: run.worktree_path,
    accepted_bundle_path: run.accepted_bundle_path,
    implementer: {
      model: "web-implementation-pack",
      reasoning_effort: "not-applicable",
      iterations: 0,
      thread_id: "",
    },
    internal_reviewer: {
      model: config.agents.internal_reviewer.model,
      reasoning_effort: config.agents.internal_reviewer.reasoning_effort,
      rounds: executor.terra_review.rounds,
      latest_thread_id: null,
      verdict: executor.terra_review.verdict,
      reviewed_change_set_sha256: executor.terra_review.change_set_digest,
    },
    final_reviewer: {
      model: config.agents.final_reviewer.model,
      reasoning_effort: config.agents.final_reviewer.reasoning_effort,
      rounds: executor.sol_review.rounds,
      latest_thread_id: null,
      verdict: executor.sol_review.verdict,
      reviewed_change_set_sha256: executor.sol_review.change_set_digest,
    },
    verification: {
      rounds: executor.verification.rounds,
      required_commands_passed: executor.verification.passed,
      verified_change_set_sha256: executor.verification.change_set_digest,
      commands: [],
    },
    errors: executor.errors,
    usage: {
      input_tokens: terraUsage.input_tokens + solUsage.input_tokens,
      cached_input_tokens: terraUsage.cached_input_tokens + solUsage.cached_input_tokens,
      output_tokens: terraUsage.output_tokens + solUsage.output_tokens,
    },
    change_set_sha256: ready.changeSetDigest,
    created_at: executor.created_at,
    updated_at: executor.updated_at,
  };

  const limits: ResultBundleLimits = {
    ...DEFAULT_RESULT_BUNDLE_LIMITS,
    ...(config.result_bundle ?? {}),
  };
  const maximumResponseBytes = limits.maximum_github_response_bytes;
  const publishDirectory = path.join(ready.executorDirectory, "publish");
  const args: Parameters<typeof packageResultBundle>[0] = {
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    githubClient: new GitHubRestAttestationClient(token, maximumResponseBytes),
    gitRunner: await createGitRunner(options.stateDirectory, limits),
    secrets: [token],
    authority: {
      executionEvidence,
      executionReceiptBytes: executorReceiptBytes,
      publishReceiptPath: path.join(publishDirectory, "git-publish.json"),
      draftReceiptPath: path.join(publishDirectory, "github-draft-pr.json"),
    },
  };
  if (config.result_bundle) args.limits = config.result_bundle;
  if (options.now) args.now = options.now;
  const result = await packageResultBundle(args);
  if (
    result.execution_receipt_sha256 !== sha256(executorReceiptBytes) ||
    result.change_set_sha256 !== ready.changeSetDigest ||
    result.base_commit !== run.base_commit
  ) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", "Result Bundle did not bind the exact selected executor authority.");
  }
  return result;
}
