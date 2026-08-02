import { GitBoundaryError, type PreparedBase, type ResolvedRepository } from "./contracts.js";
import { GitRunner } from "./git-runner.js";

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function safeBranch(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("@{") && !/[\u0000\r\n\\~^:?*\[\]]/.test(value);
}

async function objectExists(commit: string, repository: ResolvedRepository, runner: GitRunner): Promise<boolean> {
  const result = await runner.run(["cat-file", "-e", `${commit}^{commit}`], repository.path);
  return result.exitCode === 0;
}

async function refExists(ref: string, repository: ResolvedRepository, runner: GitRunner): Promise<boolean> {
  const result = await runner.run(["show-ref", "--verify", "--quiet", ref], repository.path);
  return result.exitCode === 0;
}

export async function prepareBase(
  repository: ResolvedRepository,
  baseBranch: string,
  baseCommit: string,
  runner = new GitRunner(),
): Promise<PreparedBase> {
  if (!FULL_COMMIT.test(baseCommit)) throw new GitBoundaryError("BASE_COMMIT_INVALID", "Base commit must be a full lowercase 40 or 64 character commit ID.");
  if (!safeBranch(baseBranch)) throw new GitBoundaryError("BASE_COMMIT_INVALID", "Base branch is unsafe.");
  let fetched = false;
  const trackingRef = `refs/remotes/${repository.remote}/${baseBranch}`;
  const localRef = `refs/heads/${baseBranch}`;

  if (repository.fetch_policy === "always") {
    const result = await runner.run(["fetch", "--no-tags", "--no-recurse-submodules", repository.remote, `refs/heads/${baseBranch}:refs/remotes/${repository.remote}/${baseBranch}`], repository.path);
    if (result.exitCode !== 0) throw new GitBoundaryError("FETCH_FAILED", "Fetching the trusted base branch failed.", result);
    fetched = true;
  } else if (repository.fetch_policy === "if-missing" && !(await objectExists(baseCommit, repository, runner))) {
    const result = await runner.run(["fetch", "--no-tags", "--no-recurse-submodules", repository.remote, `refs/heads/${baseBranch}:refs/remotes/${repository.remote}/${baseBranch}`], repository.path);
    if (result.exitCode !== 0) throw new GitBoundaryError("FETCH_FAILED", "Fetching the trusted base branch failed.", result);
    fetched = true;
  }

  if (!(await objectExists(baseCommit, repository, runner))) {
    if (repository.fetch_policy === "never") throw new GitBoundaryError("FETCH_DISABLED", "Base commit is missing and fetch policy is never.");
    throw new GitBoundaryError("BASE_COMMIT_NOT_FOUND", "Base commit object was not found locally after fetch.");
  }

  let trustedRef: string;
  if (await refExists(trackingRef, repository, runner)) trustedRef = trackingRef;
  else if (await refExists(localRef, repository, runner)) trustedRef = localRef;
  else throw new GitBoundaryError("BASE_COMMIT_NOT_FOUND", "Trusted base branch does not exist locally.");

  const ancestor = await runner.run(["merge-base", "--is-ancestor", baseCommit, trustedRef], repository.path);
  if (ancestor.exitCode !== 0) throw new GitBoundaryError("BASE_COMMIT_NOT_ANCESTOR", "Base commit is not an ancestor of the trusted base branch.", ancestor);
  return { base_commit: baseCommit, base_branch: baseBranch, trusted_ref: trustedRef, fetched };
}

export const verifyBaseCommit = prepareBase;
