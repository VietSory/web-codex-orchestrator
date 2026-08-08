import fs from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { GitRunner as SecureGitRunner } from "../git/git-runner.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import type { GitRunner } from "../result-bundle/git-evidence-reader.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS, type ResultBundleReceipt, type ResultBundleLimits } from "../result-bundle/contracts.js";
import { packageResultBundle } from "../result-bundle/result-bundle-service.js";
import { OrchestrationError } from "./contracts.js";
import { prepareOrchestrationDirectory } from "./ledger.js";

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

export async function packageResultForRun(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<ResultBundleReceipt> {
  const config = await loadTrustedConfig(options.configPath);
  const github = config.github_pull_request;
  if (!github) throw new OrchestrationError("ORCHESTRATION_RESULT_CONFIG_INVALID", "github_pull_request config is required to package a Result Bundle.");

  const tokenKey = github.authentication.token_environment_key;
  const token = process.env[tokenKey];
  if (!token) throw new OrchestrationError("ORCHESTRATION_RESULT_AUTH_UNAVAILABLE", `GitHub token not found at configured environment key ${tokenKey}.`);

  const limits: ResultBundleLimits = {
    ...DEFAULT_RESULT_BUNDLE_LIMITS,
    ...(config.result_bundle ?? {}),
  };
  const maximumResponseBytes = limits.maximum_github_response_bytes;
  const args: Parameters<typeof packageResultBundle>[0] = {
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    githubClient: new GitHubRestAttestationClient(token, maximumResponseBytes),
    gitRunner: await createGitRunner(options.stateDirectory, limits),
    secrets: [token],
  };
  if (config.result_bundle) args.limits = config.result_bundle;
  if (options.now) args.now = options.now;
  return await packageResultBundle(args);
}
