// CLI handlers for Phase 6: package-result and result-bundle-status
import { spawn } from "node:child_process";
import { packageResultBundle, getResultBundleStatus } from "./result-bundle-service.js";
import { isResultBundleError, resultBundleExitCode } from "./contracts.js";
import { GitHubRestAttestationClient } from "./github-attestation.js";
import type { GitRunner } from "./git-evidence-reader.js";
import { loadTrustedConfig } from "../config/config-loader.js";

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

/** Creates a simple GitRunner adapter that reuses the git binary */
function createGitRunner(): GitRunner {
  function runGit(gitArgs: string[], cwd: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", gitArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`git exited with code ${code ?? "null"}`));
          return;
        }
        resolve({ stdout: Buffer.concat(chunks).toString("utf8") });
      });
      proc.on("error", reject);
    });
  }

  function runGitBinary(gitArgs: string[], cwd: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const proc = spawn("git", gitArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`git exited with code ${code ?? "null"}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      proc.on("error", reject);
    });
  }

  return {
    run: runGit,
    runBinary: runGitBinary,
  };
}

export async function runPackageResultCommand(args: string[]): Promise<number> {
  const parsed = parsePhase6Args(args, true);
  if (!parsed || !parsed.configPath) {
    process.stderr.write(`Usage:\n${PACKAGE_RESULT_USAGE}\n`);
    return 2;
  }

  try {
    // Load config to get GitHub token
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

    const githubClient = new GitHubRestAttestationClient(token, maxResponseBytes);
    const gitRunner = createGitRunner();

    const receipt = await packageResultBundle({
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      githubClient,
      gitRunner,
    });

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
