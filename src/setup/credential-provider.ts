import type { GitHubPullRequestAuthenticationConfig, PublishAuthenticationConfig } from "../config/contracts.js";
import { redact } from "../evidence/log-redaction.js";
import { spawnBounded, type SpawnBoundedResult } from "../runtime/spawn-bounded.js";

export type GitHubAuthenticationConfig = Exclude<PublishAuthenticationConfig, { mode: "none" }> | GitHubPullRequestAuthenticationConfig;
export type CredentialProbe = (args: string[], environment: Record<string, string>) => Promise<SpawnBoundedResult>;

function ghEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA"]) if (env[key]) result[key] = env[key]!;
  result.GH_PROMPT_DISABLED = "1";
  return result;
}

const defaultProbe: CredentialProbe = async (args, environment) => await spawnBounded({
  executable: "gh", args, environment, timeoutMs: 5_000, stdoutMaxBytes: 8_192, stderrMaxBytes: 8_192, shell: false,
});

function failed(result: SpawnBoundedResult): boolean {
  return Boolean(result.spawnError || result.timedOut || result.cancelled || result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0);
}

function validToken(token: string): boolean {
  return token.length >= 1 && token.length <= 4096 && token === token.trim() && !/[\r\n\0]/.test(token);
}

export async function resolveGitHubToken(
  authentication: GitHubAuthenticationConfig,
  env: NodeJS.ProcessEnv = process.env,
  probe: CredentialProbe = defaultProbe,
): Promise<string> {
  if (authentication.mode === "https_token") {
    const token = env[authentication.token_environment_key] ?? "";
    if (!validToken(token)) throw new Error("GITHUB_AUTH_UNAVAILABLE: configured token environment variable is missing or invalid.");
    return token;
  }
  const clean = ghEnvironment(env);
  const status = await probe(["auth", "status", "--hostname", "github.com"], clean);
  if (failed(status)) throw new Error(`GITHUB_AUTH_UNAVAILABLE: gh authentication could not be verified: ${redact(status.stderr).slice(-512) || "gh unavailable"}`);
  const tokenResult = await probe(["auth", "token", "--hostname", "github.com"], clean);
  const token = tokenResult.stdout.trim();
  if (failed(tokenResult) || !validToken(token)) throw new Error("GITHUB_AUTH_UNAVAILABLE: gh did not return a valid in-process token.");
  return token;
}
