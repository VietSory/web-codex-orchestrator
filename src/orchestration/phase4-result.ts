import fs from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { GitRunner as SecureGitRunner } from "../git/git-runner.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS, type ResultBundleLimits, type ResultBundleReceipt } from "../result-bundle/contracts.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import type { GitRunner } from "../result-bundle/git-evidence-reader.js";
import { packageResultBundle } from "../result-bundle/result-bundle-service.js";
import { resolveGitHubToken } from "../setup/credential-provider.js";
import { prepareOrchestrationDirectory } from "./ledger.js";
import { OrchestrationError } from "./contracts.js";

async function prepareGitRuntime(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory, "orchestration", "phase4-result-git-runtime");
  await prepareOrchestrationDirectory(stateDirectory, runtime);
  const hooks = path.join(runtime, "empty-hooks");
  await fs.mkdir(hooks, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const hooksStat = await fs.lstat(hooks);
  if (hooksStat.isSymbolicLink() || !hooksStat.isDirectory() || await fs.realpath(hooks) !== hooks) {
    throw new OrchestrationError("AUTOPILOT_RESULT_GIT_UNSAFE", "Result Git hooks directory is unsafe.");
  }
  const emptyConfig = path.join(runtime, "empty-config");
  try {
    await fs.writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(emptyConfig);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0) {
      throw new OrchestrationError("AUTOPILOT_RESULT_GIT_UNSAFE", "Result Git config boundary is unsafe.");
    }
  }
  return runtime;
}

async function createGitRunner(stateDirectory: string, limits: ResultBundleLimits): Promise<GitRunner> {
  const maximumEvidenceBytes = Math.max(limits.maximum_diff_bytes, limits.maximum_source_file_bytes) + 1;
  return new SecureGitRunner(process.env, await prepareGitRuntime(stateDirectory), undefined, {
    stdoutMaxBytes: maximumEvidenceBytes,
    stderrMaxBytes: Math.min(1_048_576, maximumEvidenceBytes),
  });
}

export async function packagePhase4ResultForRun(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<ResultBundleReceipt> {
  const config = await loadTrustedConfig(options.configPath);
  const github = config.github_pull_request;
  if (!github) throw new OrchestrationError("AUTOPILOT_RESULT_CONFIG_INVALID", "github_pull_request config is required to package an AUTOPILOT Result Bundle.");

  let token: string;
  try {
    token = await resolveGitHubToken(github.authentication);
  } catch {
    throw new OrchestrationError("AUTOPILOT_RESULT_AUTH_UNAVAILABLE", "GitHub credentials are unavailable for Result Bundle attestation.");
  }

  const limits: ResultBundleLimits = {
    ...DEFAULT_RESULT_BUNDLE_LIMITS,
    ...(config.result_bundle ?? {}),
  };
  const args: Parameters<typeof packageResultBundle>[0] = {
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    githubClient: new GitHubRestAttestationClient(token, limits.maximum_github_response_bytes),
    gitRunner: await createGitRunner(options.stateDirectory, limits),
    secrets: [token],
  };
  if (config.result_bundle) args.limits = config.result_bundle;
  if (options.now) args.now = options.now;
  return await packageResultBundle(args);
}
