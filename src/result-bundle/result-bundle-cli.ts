// CLI handlers for Phase 6: package-result and result-bundle-status
import { packageResultBundle, getResultBundleStatus } from "./result-bundle-service.js";
import { DEFAULT_RESULT_BUNDLE_LIMITS, isResultBundleError, resultBundleExitCode } from "./contracts.js";
import { GitHubRestAttestationClient } from "./github-attestation.js";
import type { GitRunner } from "./git-evidence-reader.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { spawnBounded, spawnBoundedBinary } from "../runtime/spawn-bounded.js";

export const PACKAGE_RESULT_USAGE = `\
  wco package-result --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> [--json]
  wco result-bundle-status --run-id <task-id:archive-sha256> --state-dir <directory> [--json]`;

interface Phase6Args {
  runId: string;
  stateDirectory: string;
  configPath?: string;
  json: boolean;
}

function parsePhase6Args(args: string[], requireConfig: boolean): Phase6Args | null {
  let runId: string | undefined;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") { if (json) return null; json = true; continue; }
    if (arg === "--run-id" || arg === "--state-dir" || arg === "--config") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id" && runId === undefined) runId = value;
      else if (arg === "--state-dir" && stateDirectory === undefined) stateDirectory = value;
      else if (arg === "--config" && configPath === undefined) configPath = value;
      else return null;
      i += 1;
      continue;
    }
    return null;
  }
  if (!runId || !stateDirectory || requireConfig && !configPath) return null;
  return { runId, stateDirectory, ...(configPath !== undefined ? { configPath } : {}), json };
}

function gitEvidenceEnvironment(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function gitFailure(result: { exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; stderr: string | Buffer; spawnError?: unknown }): string | null {
  if (result.exitCode === 0 && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated && result.spawnError === undefined) return null;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
  if (result.timedOut) return "git evidence command timed out";
  if (result.stdoutTruncated || result.stderrTruncated) return "git evidence command exceeded its bounded output limit";
  if (result.spawnError instanceof Error) return result.spawnError.message;
  if (result.spawnError !== undefined) return String(result.spawnError);
  return stderr.trim() || `git exited with code ${result.exitCode ?? "null"}`;
}

/** Read-only Git evidence runner with exact binary bytes plus bounded resources. */
function createGitRunner(limits: { maximumDiffBytes: number; maximumSourceFileBytes: number }): GitRunner {
  const environment = gitEvidenceEnvironment();
  const timeoutMs = 120_000;
  const stderrMaxBytes = 1_048_576;
  return {
    async run(gitArgs: string[], cwd: string): Promise<{ stdout: string }> {
      const result = await spawnBounded({
        executable: "git",
        args: gitArgs,
        cwd,
        environment,
        timeoutMs,
        stdoutMaxBytes: 16 * 1024 * 1024,
        stderrMaxBytes,
        shell: false,
      });
      const failure = gitFailure(result);
      if (failure) throw new Error(failure);
      return { stdout: result.stdout };
    },
    async runBinary(gitArgs: string[], cwd: string): Promise<Buffer> {
      const sourceRead = gitArgs.includes("show");
      const stdoutMaxBytes = sourceRead ? limits.maximumSourceFileBytes : limits.maximumDiffBytes;
      const result = await spawnBoundedBinary({
        executable: "git",
        args: gitArgs,
        cwd,
        environment,
        timeoutMs,
        stdoutMaxBytes,
        stderrMaxBytes,
        shell: false,
      });
      const failure = gitFailure(result);
      if (failure) throw new Error(failure);
      return result.stdout;
    },
  };
}

export async function runPackageResultCommand(args: string[]): Promise<number> {
  const parsed = parsePhase6Args(args, true);
  if (!parsed || !parsed.configPath) {
    process.stderr.write(`Usage:\n${PACKAGE_RESULT_USAGE}\n`);
    return 2;
  }

  try {
    const configResult = await loadTrustedConfig(parsed.configPath);
    const githubConfig = configResult.github_pull_request;
    if (!githubConfig) {
      throw Object.assign(new Error("github_pull_request config is required for Phase 6."), { code: "RESULT_CONFIG_INVALID" });
    }
    const tokenKey = githubConfig.authentication.token_environment_key;
    const token = process.env[tokenKey];
    if (!token) {
      const err = new Error(`GitHub token not found at environment key: ${tokenKey}`);
      Object.assign(err, { code: "RESULT_PR_AUTH_UNAVAILABLE" });
      throw err;
    }

    const resultBundleConfig = configResult.result_bundle;
    const effective = { ...DEFAULT_RESULT_BUNDLE_LIMITS, ...(resultBundleConfig ?? {}) };
    const githubClient = new GitHubRestAttestationClient(token, effective.maximum_github_response_bytes);
    const gitRunner = createGitRunner({
      maximumDiffBytes: effective.maximum_diff_bytes,
      maximumSourceFileBytes: effective.maximum_source_file_bytes,
    });

    const receipt = await packageResultBundle({
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      githubClient,
      gitRunner,
      secrets: [token],
      ...(resultBundleConfig ? { limits: resultBundleConfig } : {}),
    });

    if (parsed.json) process.stdout.write(JSON.stringify(receipt) + "\n");
    else {
      console.log(`State: ${receipt.state}`);
      console.log(`Archive: ${receipt.archive_relative_path}`);
      console.log(`SHA-256: ${receipt.archive_sha256}`);
      console.log(`Size: ${receipt.archive_size_bytes} bytes`);
      console.log(`Entries: ${receipt.entry_count}`);
      console.log(`Pull Request: #${receipt.pull_request.number} (${receipt.pull_request.url})`);
      for (const warning of receipt.warnings) console.warn(`Warning: ${warning}`);
    }
    return 0;
  } catch (error) {
    const code = isResultBundleError(error) ? error.code : "RESULT_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
    else process.stderr.write(`${code}: ${message}\n`);
    return isResultBundleError(error) ? resultBundleExitCode(error.code) : 3;
  }
}

export async function runResultBundleStatusCommand(args: string[]): Promise<number> {
  const parsed = parsePhase6Args(args, false);
  if (!parsed) {
    process.stderr.write(`Usage:\n${PACKAGE_RESULT_USAGE}\n`);
    return 2;
  }
  try {
    const receipt = await getResultBundleStatus({ runId: parsed.runId, stateDirectory: parsed.stateDirectory });
    if (!receipt) {
      if (parsed.json) process.stdout.write(JSON.stringify({ status: "NOT_FOUND" }) + "\n");
      else process.stderr.write("No result bundle receipt found.\n");
      return 3;
    }
    if (parsed.json) process.stdout.write(JSON.stringify(receipt) + "\n");
    else {
      console.log(`State: ${receipt.state}`);
      console.log(`Run ID: ${receipt.run_id}`);
      if (receipt.state === "READY_FOR_WEB_REVIEW") {
        console.log(`Archive: ${receipt.archive_relative_path}`);
        console.log(`SHA-256: ${receipt.archive_sha256}`);
        console.log(`Pull Request: #${receipt.pull_request.number} (${receipt.pull_request.url})`);
      }
    }
    return receipt.state === "READY_FOR_WEB_REVIEW" ? 0 : 1;
  } catch (error) {
    const code = isResultBundleError(error) ? error.code : "RESULT_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
    else process.stderr.write(`${code}: ${message}\n`);
    return 3;
  }
}
