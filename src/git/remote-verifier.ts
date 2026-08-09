import type { GitCommandResult, ResolvedRepository, VerifiedRemote } from "./contracts.js";
import { GitBoundaryError } from "./contracts.js";
import { sanitizeRemoteUrl } from "../config/remote-url.js";
import { GitRunner } from "./git-runner.js";

function redactedResult(result: GitCommandResult, stdout = ""): GitCommandResult {
  return { ...result, stdout, stderr: "" };
}

function parseUrls(result: GitCommandResult, repository: ResolvedRepository, kind: "fetch" | "push"): string[] {
  if (result.exitCode !== 0) {
    if (/does not appear to be a git repository|No such remote|No such remote/i.test(result.stderr)) {
      throw new GitBoundaryError("REMOTE_NOT_FOUND", `Configured remote has no usable ${kind} URL.`, redactedResult(result));
    }
    throw new GitBoundaryError("REMOTE_NOT_ALLOWED", `Git remote ${kind} URLs could not be inspected.`, redactedResult(result));
  }
  const urls = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0) throw new GitBoundaryError("REMOTE_NOT_FOUND", `Configured remote has no ${kind} URLs.`, redactedResult(result));
  const unexpected = urls.filter((url) => !repository.expected_remote_urls.includes(url));
  if (unexpected.length > 0) {
    throw new GitBoundaryError(
      "REMOTE_URL_MISMATCH",
      `Configured remote contains an untrusted effective ${kind} URL.`,
      redactedResult(result, urls.map((url) => sanitizeRemoteUrl(url)).join("\n")),
    );
  }
  return urls;
}

export async function verifyRemote(
  repository: ResolvedRepository,
  runner = new GitRunner(),
): Promise<VerifiedRemote> {
  const fetchResult = await runner.run(["remote", "get-url", "--all", repository.remote], repository.path);
  const fetchUrls = parseUrls(fetchResult, repository, "fetch");
  const pushResult = await runner.run(["remote", "get-url", "--push", "--all", repository.remote], repository.path);
  parseUrls(pushResult, repository, "push");

  return {
    remote: repository.remote,
    urls: fetchUrls.map((url) => sanitizeRemoteUrl(url)),
    matched_url: sanitizeRemoteUrl(fetchUrls[0]!),
  };
}

export const verifyRegisteredRemote = verifyRemote;
