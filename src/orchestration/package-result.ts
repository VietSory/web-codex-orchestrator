import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadTrustedConfig } from "../config/config-loader.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import type { GitRunner } from "../result-bundle/git-evidence-reader.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { packageResultBundle } from "../result-bundle/result-bundle-service.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import { spawnBounded } from "../runtime/spawn-bounded.js";
import { executionPaths } from "../execution/execution-store.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { OrchestrationError } from "./contracts.js";

const MAX_COMPAT_RECEIPT_BYTES = 16 * 1024 * 1024;
const MIN_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(taskBundleSha256)) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Invalid run_id for Result Bundle packaging.");
  }
  return { taskId, taskBundleSha256 };
}

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", `${label} escapes its WCO state root.`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", `Result artifact is not a regular non-symlink file: ${filePath}`);
  }
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  const handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function writeDurable(filePath: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function copyCompatibilityReceipt(source: string, target: string): Promise<void> {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_COMPAT_RECEIPT_BYTES) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Upstream publication receipt is unsafe or oversized.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

async function installPromotedFile(source: string, target: string, expectedSha256: string): Promise<void> {
  const sourceInfo = await fs.lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Compatibility Result Bundle output is unsafe.");
  }
  const existing = await fs.lstat(target).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || await sha256File(target) !== expectedSha256) {
      throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Existing Result Bundle artifact conflicts with the exact completed package.");
    }
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.copyFile(source, temp, fsConstants.COPYFILE_EXCL);
    if (await sha256File(temp) !== expectedSha256) {
      throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Promoted Result Bundle artifact changed while copying.");
    }
    const handle = await fs.open(temp, "r+");
    try { await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

function cleanGitEnvironment(): Record<string, string> {
  const result: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function createGitRunner(maximumOutputBytes: number): GitRunner {
  const outputCap = Math.max(MIN_GIT_OUTPUT_BYTES, Math.min(MAX_GIT_OUTPUT_BYTES, maximumOutputBytes));
  async function invoke(args: string[], cwd: string) {
    const result = await spawnBounded({
      executable: "git",
      args,
      cwd,
      environment: cleanGitEnvironment(),
      timeoutMs: GIT_TIMEOUT_MS,
      stdoutMaxBytes: outputCap,
      stderrMaxBytes: 256 * 1024,
      shell: false,
    });
    if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      const reason = result.timedOut ? "timed out" : result.stdoutTruncated || result.stderrTruncated ? "exceeded bounded output" : `exited with code ${result.exitCode ?? "null"}`;
      throw new OrchestrationError("ORCHESTRATION_RESULT_GIT_FAILED", `git ${reason}: ${result.stderr.slice(-4096)}`);
    }
    return result;
  }
  return {
    async run(args: string[], cwd: string) { return { stdout: (await invoke(args, cwd)).stdout }; },
    async runBinary(args: string[], cwd: string) {
      const result = await invoke(args, cwd);
      return result.stdoutBuffer ?? Buffer.from(result.stdout, "utf8");
    },
  };
}

export interface PackageResultDependencies {
  loadConfig: typeof loadTrustedConfig;
  readSelectedArtifact: typeof readSelectedArtifact;
  attestReadyExecutor: typeof attestReadyExecutorSnapshot;
  packageBundle: typeof packageResultBundle;
}

const productionDependencies: PackageResultDependencies = {
  loadConfig: loadTrustedConfig,
  readSelectedArtifact,
  attestReadyExecutor: attestReadyExecutorSnapshot,
  packageBundle: packageResultBundle,
};

function compatibilityExecutionReceipt(
  ready: Awaited<ReturnType<typeof attestReadyExecutorSnapshot>>,
  config: Awaited<ReturnType<typeof loadTrustedConfig>>,
  executorReceiptSha256: string,
): Record<string, unknown> {
  const receipt = ready.receipt;
  const run = ready.source.trusted.runReceipt;
  const digest = ready.changeSetDigest;
  const agents = config.agents;
  if (!agents) throw new OrchestrationError("ORCHESTRATION_RESULT_CONFIG_INVALID", "Agent profiles are required to project Phase 10 review evidence into the Result Bundle.");
  return {
    execution_version: "1.0",
    projection_version: "phase13-executor-v1",
    source_executor_receipt_sha256: executorReceiptSha256,
    run_id: receipt.run_id,
    state: "READY_FOR_PUBLISH",
    base_commit: receipt.base_commit,
    base_branch: receipt.base_branch,
    branch_name: run.branch_name,
    worktree_path: receipt.worktree_path,
    accepted_bundle_path: run.accepted_bundle_path,
    implementer: { model: "web-authority", reasoning_effort: "deterministic", iterations: 0, thread_id: "" },
    internal_reviewer: {
      model: agents.internal_reviewer.model,
      reasoning_effort: agents.internal_reviewer.reasoning_effort,
      rounds: receipt.terra_review.rounds,
      latest_thread_id: null,
      verdict: receipt.terra_review.verdict,
      reviewed_change_set_sha256: digest,
    },
    final_reviewer: {
      model: agents.final_reviewer.model,
      reasoning_effort: agents.final_reviewer.reasoning_effort,
      rounds: receipt.sol_review.rounds,
      latest_thread_id: null,
      verdict: receipt.sol_review.verdict,
      reviewed_change_set_sha256: digest,
    },
    verification: {
      commands: [],
      rounds: receipt.verification.rounds,
      required_commands_passed: receipt.verification.passed,
      verified_change_set_sha256: digest,
    },
    errors: receipt.errors,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    change_set_sha256: digest,
    created_at: receipt.created_at,
    updated_at: receipt.updated_at,
  };
}

async function existingReadyResult(stateDirectory: string, runId: string): Promise<ResultBundleReceipt | null> {
  const id = splitRunId(runId);
  const paths = resultBundlePaths(path.resolve(stateDirectory), id.taskId, id.taskBundleSha256);
  const receipt = await readResultBundleReceipt(paths.receiptPath);
  if (!receipt || receipt.run_id !== runId || receipt.state !== "READY_FOR_WEB_REVIEW" || !receipt.archive_relative_path || !receipt.archive_sha256) return null;
  const archivePath = path.resolve(stateDirectory, receipt.archive_relative_path);
  assertContained(stateDirectory, archivePath, "Existing Result Bundle archive");
  if (await sha256File(archivePath) !== receipt.archive_sha256) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Existing READY_FOR_WEB_REVIEW archive no longer matches its receipt.");
  }
  return receipt;
}

export async function packageResultForRun(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}, dependencyOverrides: Partial<PackageResultDependencies> = {}): Promise<ResultBundleReceipt> {
  const existing = await existingReadyResult(options.stateDirectory, options.runId);
  if (existing) return existing;

  const deps = { ...productionDependencies, ...dependencyOverrides };
  const config = await deps.loadConfig(options.configPath);
  const github = config.github_pull_request;
  if (!github) throw new OrchestrationError("ORCHESTRATION_RESULT_CONFIG_INVALID", "github_pull_request config is required to package a Result Bundle.");

  const tokenKey = github.authentication.token_environment_key;
  const token = process.env[tokenKey];
  if (!token) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTH_UNAVAILABLE", `GitHub token not found at configured environment key ${tokenKey}.`);

  const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
  if (!selected) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected Phase 9 artifact exists for Result Bundle packaging.");
  const ready = await deps.attestReadyExecutor({
    runId: options.runId,
    artifactSha256: selected.artifact_sha256,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
  });
  const run = ready.source.trusted.runReceipt;
  const publishPath = path.join(ready.executorDirectory, "publish", "git-publish.json");
  const draftPath = path.join(ready.executorDirectory, "publish", "github-draft-pr.json");
  const [publish, draft] = await Promise.all([
    readGitPublishReceipt(publishPath),
    readDraftPullRequestReceipt(draftPath),
  ]);
  if (!publish || publish.state !== "PUSHED" || publish.run_id !== options.runId || publish.base_commit !== run.base_commit || publish.branch_name !== run.branch_name || publish.change_set_sha256 !== ready.changeSetDigest || publish.commit_sha === null || publish.remote_branch_sha !== publish.commit_sha) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Phase 13 requires the exact executor-scoped PUSHED publication receipt.");
  }
  if (!draft || draft.state !== "OPEN" || draft.run_id !== options.runId || draft.pull_number === null || draft.expected_head_sha !== publish.commit_sha || draft.observed_head_sha !== publish.commit_sha || draft.observed_state !== "open" || draft.observed_draft !== true) {
    throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Phase 13 requires the exact executor-scoped open Draft PR receipt.");
  }

  const id = splitRunId(options.runId);
  await fs.mkdir(path.resolve(options.stateDirectory), { recursive: true, mode: 0o700 });
  const compatibilityRoot = await fs.mkdtemp(path.join(path.resolve(options.stateDirectory), ".phase13-result-compat-"));
  try {
    const compatExecutionPaths = executionPaths(compatibilityRoot, id.taskId, id.taskBundleSha256);
    const executorReceiptSha256 = await sha256File(path.join(ready.executorDirectory, "executor-receipt.json"));
    await writeDurable(compatExecutionPaths.execution, canonicalJsonBuffer(compatibilityExecutionReceipt(ready, config, executorReceiptSha256)));
    await copyCompatibilityReceipt(publishPath, path.join(compatExecutionPaths.directory, "publish", "git-publish.json"));
    await copyCompatibilityReceipt(draftPath, path.join(compatibilityRoot, "publish", "github-draft-pr.json"));

    const limits = config.result_bundle;
    const maximumResponseBytes = Number(limits?.maximum_github_response_bytes ?? 1_048_576);
    const processOutputCap = Math.max(
      MIN_GIT_OUTPUT_BYTES,
      Number(limits?.maximum_diff_bytes ?? 0),
      Number(limits?.maximum_source_file_bytes ?? 0),
    );
    const args: Parameters<typeof packageResultBundle>[0] = {
      runId: options.runId,
      stateDirectory: compatibilityRoot,
      configPath: options.configPath,
      githubClient: new GitHubRestAttestationClient(token, maximumResponseBytes),
      gitRunner: createGitRunner(processOutputCap),
      secrets: [token],
    };
    if (limits) args.limits = limits;
    if (options.now) args.now = options.now;
    const receipt = await deps.packageBundle(args);
    if (receipt.state !== "READY_FOR_WEB_REVIEW" || receipt.run_id !== options.runId || !receipt.archive_relative_path || !receipt.archive_sha256) {
      throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Compatibility Result Bundle builder did not produce an exact READY_FOR_WEB_REVIEW handoff.");
    }

    const sourceArchive = path.resolve(compatibilityRoot, receipt.archive_relative_path);
    const destinationArchive = path.resolve(options.stateDirectory, receipt.archive_relative_path);
    assertContained(compatibilityRoot, sourceArchive, "Compatibility Result Bundle archive");
    assertContained(options.stateDirectory, destinationArchive, "Promoted Result Bundle archive");
    const sourceReceipt = resultBundlePaths(compatibilityRoot, id.taskId, id.taskBundleSha256).receiptPath;
    const destinationReceipt = resultBundlePaths(options.stateDirectory, id.taskId, id.taskBundleSha256).receiptPath;
    await installPromotedFile(sourceArchive, destinationArchive, receipt.archive_sha256);
    await installPromotedFile(sourceReceipt, destinationReceipt, await sha256File(sourceReceipt));
    return receipt;
  } finally {
    await fs.rm(compatibilityRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
