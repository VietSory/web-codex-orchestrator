import { spawn } from "node:child_process";
import { loadTrustedConfig } from "../config/config-loader.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import type { GitRunner } from "../result-bundle/git-evidence-reader.js";
import { packageResultBundle } from "../result-bundle/result-bundle-service.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import { OrchestrationError } from "./contracts.js";

function createGitRunner(): GitRunner {
  function run(args: string[], cwd: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new OrchestrationError("ORCHESTRATION_RESULT_GIT_FAILED", `git exited with code ${code ?? "null"}: ${Buffer.concat(stderr).toString("utf8").slice(0, 4096)}`));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      });
    });
  }

  function runBinary(args: string[], cwd: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new OrchestrationError("ORCHESTRATION_RESULT_GIT_FAILED", `git exited with code ${code ?? "null"}: ${Buffer.concat(stderr).toString("utf8").slice(0, 4096)}`));
          return;
        }
        resolve(Buffer.concat(stdout));
      });
    });
  }

  return { run, runBinary };
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

  const limits = config.result_bundle;
  const maximumResponseBytes = Number(limits?.maximum_github_response_bytes ?? 1_048_576);
  const args: Parameters<typeof packageResultBundle>[0] = {
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    githubClient: new GitHubRestAttestationClient(token, maximumResponseBytes),
    gitRunner: createGitRunner(),
    secrets: [token],
  };
  if (limits) args.limits = limits;
  if (options.now) args.now = options.now;
  return await packageResultBundle(args);
}
