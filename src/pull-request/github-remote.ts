import { DraftPullRequestError } from "./contracts.js";

export interface GitHubRepositoryIdentity {
  owner: string;
  repository: string;
  fullName: string;
}

export function parseGitHubRepositoryRemote(remoteUrl: string): GitHubRepositoryIdentity {
  if (typeof remoteUrl !== "string") {
    throw new DraftPullRequestError("PR_REMOTE_UNSUPPORTED", "Remote URL must be a string.");
  }

  const match = remoteUrl.match(/^https:\/\/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new DraftPullRequestError("PR_REMOTE_UNSUPPORTED", "Remote URL must be exactly https://github.com/owner/repo[.git] without credentials, ports, or query fragments.");
  }

  let owner = match[1]!;
  let repository = match[2]!;

  if (repository.endsWith(".git")) {
    repository = repository.slice(0, -4);
  }

  if (repository === "." || repository === "..") {
    throw new DraftPullRequestError("PR_REMOTE_UNSUPPORTED", "Remote URL must contain a valid owner and repository.");
  }

  if (owner.length > 39 || repository.length > 100) {
    throw new DraftPullRequestError("PR_REMOTE_UNSUPPORTED", "Owner or repository name exceeds maximum length.");
  }

  return {
    owner,
    repository,
    fullName: `${owner}/${repository}`,
  };
}
