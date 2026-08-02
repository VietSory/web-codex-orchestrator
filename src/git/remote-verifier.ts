import type { GitCommandResult, ResolvedRepository, VerifiedRemote } from "./contracts.js";
import { GitBoundaryError } from "./contracts.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
import { GitRunner } from "./git-runner.js";

function redactedResult(result: GitCommandResult, stdout = ""): GitCommandResult {
  return { ...result, stdout, stderr: "" };
}

export async function verifyRemote(
  repository: ResolvedRepository,
  runner = new GitRunner(),
): Promise<VerifiedRemote> {
  const result = await runner.run(["remote", "get-url", "--all", repository.remote], repository.path);
  if (result.exitCode !== 0) {
    if (/does not appear to be a git repository|No such remote|No such remote/i.test(result.stderr)) throw new GitBoundaryError("REMOTE_NOT_FOUND", "Configured remote does not exist.", redactedResult(result));
    throw new GitBoundaryError("REMOTE_NOT_ALLOWED", "Git remote could not be inspected.", redactedResult(result));
  }
  const urls = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0) throw new GitBoundaryError("REMOTE_NOT_FOUND", "Configured remote has no URLs.", redactedResult(result));
  const matched_url = urls.find((url) => repository.expected_remote_urls.includes(url));
  if (!matched_url) throw new GitBoundaryError("REMOTE_URL_MISMATCH", "Configured remote URL does not match the trusted registry.", redactedResult(result, urls.map((url) => sanitizeRemoteUrl(url)).join("\n")));
  return {
    remote: repository.remote,
    urls: urls.map((url) => sanitizeRemoteUrl(url)),
    matched_url: sanitizeRemoteUrl(matched_url),
  };
}

export const verifyRegisteredRemote = verifyRemote;
