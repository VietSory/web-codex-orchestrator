// CLI handlers for Phase 6: package-result and result-bundle-status
import { packageResultBundle, getResultBundleStatus } from "./result-bundle-service.js";
import { isResultBundleError, resultBundleExitCode } from "./contracts.js";
import { GitHubRestAttestationClient } from "./github-attestation.js";
import type { GitRunner } from "./git-evidence-reader.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { spawnBounded } from "../runtime/spawn-bounded.js";

const MIN_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

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
    if (arg === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
    if (arg === "--run-id" || arg === "--state-dir" || arg === "--config") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id" && runId === undefined) runId = value;
      else if (arg === "--state-dir" && stateDirectory === undefined) stateDirectory = value;
      else if (arg === "--config" && configPath === undefined) configPath = value;
      else return null;
      i++;
      continue;
    }
    return null;
  }

  if (!runId || !stateDirectory) return null;
  if (requireConfig && !configPath) return null;

  const result: Phase6Args = { runId, stateDirectory, json };
  if (configPath !== undefined) result.configPath = configPath;
  return result;
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
  async function runBounded(gitArgs: string[], cwd: string) {
    const result = await spawnBounded({
      executable: "git",
      args: gitArgs,
      cwd,
      environment: cleanGitEnvironment(),
      timeoutMs: GIT_TIMEOUT_MS,
      stdoutMaxBytes: outputCap,
      stderrMaxBytes: 256 * 1024,
      shell: false,
    });
    if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      const reason = result.timedOut ? "timed out" : result.stdoutTruncated || result.stderrTruncated ? "exceeded bounded output" : `exited with code ${result.exitCode ?? "null"}`;
      throw new Error(`git ${reason}: ${result.stderr.slice(-4096)}`);
    }
    return result;
  }

  return {
    async run(gitArgs: string[], cwd: string) {
      return { stdout: (await runBounded(gitArgs, cwd)).stdout };
    },
    async runBinary(gitArgs: string[], cwd: string) {
      const result = await runBounded(gitArgs, cwd);
      return result.stdoutBuffer ?? Buffer.from(result.stdout, "utf8");
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
    const maxResponseBytes = Number(resultBundleConfig?.maximum_github_response_bytes ?? 1_048_576);
    const processOutputCap = Math.max(
      MIN_GIT_OUTPUT_BYTES,
      Number(resultBundleConfig?.maximum_diff_bytes ?? 0),
      Number(resultBundleConfig?.maximum_source_file_bytes ?? 0),
    );

    const githubClient = new GitHubRestAttestationClient(token, maxResponseBytes);
    const gitRunner = createGitRunner(processOutputCap);

    const opts: Parameters<typeof packageResultBundle>[0] = {
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      githubClient,
      gitRunner,
      secrets: [token],
    };
    if (resultBundleConfig) opts.limits = resultBundleConfig;
    const receipt = await packageResultBundle(opts);

    if (parsed.json) {
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } else {
      console.log(`State: ${receipt.state}`);
      console.log(`Archive: ${receipt.archive_relative_path}`);
      console.log(`SHA-256: ${receipt.archive_sha256}`);
      console.log(`Size: ${receipt.archive_size_bytes} bytes`);
      console.log(`Entries: ${receipt.entry_count}`);
      console.log(`Pull Request: #${receipt.pull_request.number} (${receipt.pull_request.url})`);
      if (receipt.warnings.length > 0) {
        for (const w of receipt.warnings) console.warn(`Warning: ${w}`);
      }
    }
    return 0;
  } catch (error) {
    const code = isResultBundleError(error) ? error.code : "RESULT_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
    } else {
      process.stderr.write(`${code}: ${message}\n`);
    }
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
    const receipt = await getResultBundleStatus({
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
    });
    if (!receipt) {
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ status: "NOT_FOUND" }) + "\n");
      } else {
        process.stderr.write("No result bundle receipt found.\n");
      }
      return 3;
    }
    if (parsed.json) {
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } else {
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
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
    } else {
      process.stderr.write(`${code}: ${message}\n`);
    }
    return 3;
  }
}
