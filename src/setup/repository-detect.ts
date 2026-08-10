import path from "node:path";
import { realpath } from "node:fs/promises";
import { spawnBounded, type SpawnBoundedResult } from "../runtime/spawn-bounded.js";

export interface RepositoryDiscovery {
  root: string;
  head: string;
  current_branch: string | null;
  remote: string;
  remote_url: string;
  expected_remote_urls: string[];
  base_branch: string;
  base_commit: string;
  repository_id: string;
  github_repository: string | null;
  dirty: boolean;
  git_user_name: string | null;
  git_user_email: string | null;
}

export type GitProbe = (args: string[], cwd: string) => Promise<SpawnBoundedResult>;

function environment(): Record<string, string> {
  const result: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TMP", "TEMP"]) if (process.env[key]) result[key] = process.env[key]!;
  return result;
}

const defaultProbe: GitProbe = async (args, cwd) => await spawnBounded({
  executable: "git", args: ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", ...args], cwd,
  environment: environment(), timeoutMs: 5_000, stdoutMaxBytes: 2_097_152, stderrMaxBytes: 65_536, shell: false,
});

function output(result: SpawnBoundedResult, label: string, allowFailure = false): string {
  if (result.spawnError || result.timedOut || result.cancelled || result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0) {
    if (allowFailure) return "";
    throw new Error(`REPOSITORY_DETECTION_FAILED: ${label} failed without changing the repository.`);
  }
  return result.stdout.trim();
}

function githubIdentity(remoteUrl: string): { full: string; id: string } | null {
  const match = remoteUrl.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  const owner = match[1]!;
  const repository = match[2]!;
  return { full: `${owner}/${repository}`, id: repository.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64) };
}

export async function detectRepository(cwd: string, probe: GitProbe = defaultProbe): Promise<RepositoryDiscovery> {
  const root = await realpath(path.resolve(output(await probe(["rev-parse", "--show-toplevel"], cwd), "repository root")));
  const [headResult, branchResult, remotesResult, statusResult, nameResult, emailResult] = await Promise.all([
    probe(["rev-parse", "HEAD"], root), probe(["branch", "--show-current"], root), probe(["remote"], root),
    probe(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root), probe(["config", "--get", "user.name"], root), probe(["config", "--get", "user.email"], root),
  ]);
  const head = output(headResult, "HEAD");
  const currentBranch = output(branchResult, "current branch", true) || null;
  const remotes = output(remotesResult, "Git remotes").split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("REPOSITORY_DETECTION_FAILED: no Git remote is configured. No configuration was written.");
  const urlsRaw = output(await probe(["remote", "get-url", "--all", remote], root), "remote URL");
  const urls = [...new Set(urlsRaw.split("\n").map((entry) => entry.trim()).filter(Boolean))];
  if (urls.length === 0 || urls.some((url) => /https?:\/\/[^/]*@/i.test(url))) throw new Error("REPOSITORY_DETECTION_FAILED: remote URL is missing or contains credentials.");
  const pushUrlsRaw = output(await probe(["remote", "get-url", "--push", "--all", remote], root), "remote push URL");
  const pushUrls = [...new Set(pushUrlsRaw.split("\n").map((entry) => entry.trim()).filter(Boolean))];
  if (pushUrls.length !== urls.length || pushUrls.some((url) => !urls.includes(url))) throw new Error("REPOSITORY_DETECTION_FAILED: fetch and push URLs differ; align the remote before setup so WCO can seal one exact transport identity.");
  const remoteUrl = urls[0]!;
  const github = githubIdentity(remoteUrl);
  const candidates = [currentBranch, "main", "master"].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);
  let baseBranch = currentBranch ?? "main";
  let baseCommit = head;
  for (const candidate of candidates) {
    const resolved = output(await probe(["rev-parse", "--verify", `${remote}/${candidate}^{commit}`], root), `base ${candidate}`, true);
    if (resolved) { baseBranch = candidate; baseCommit = resolved; break; }
  }
  const fallbackId = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64);
  return {
    root, head, current_branch: currentBranch, remote, remote_url: remoteUrl, expected_remote_urls: urls,
    base_branch: baseBranch, base_commit: baseCommit, repository_id: github?.id || fallbackId || "repository",
    github_repository: github?.full ?? null, dirty: output(statusResult, "status").length > 0,
    git_user_name: output(nameResult, "git user.name", true) || null, git_user_email: output(emailResult, "git user.email", true) || null,
  };
}
