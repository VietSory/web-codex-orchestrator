// Core orchestrator for Phase 7 Web Review Verdict Processing
import path from "node:path";
import { WebReviewError } from "./contracts.js";
import type { WebReviewReceipt, WebReviewState, DecisionAction } from "./contracts.js";
import { resolveReviewRoundPaths } from "./web-review-paths.js";
import { acquireReviewLock } from "./web-review-lock.js";
import { readWebReviewReceipt, writeWebReviewReceipt, writeCanonicalArtifact } from "./web-review-store.js";
import { readAndCanonicalizeVerdict } from "./verdict-source-reader.js";
import { loadAndVerifyResultBundle } from "./result-bundle-review-reader.js";
import { checkRoundIdempotency, validateReviewHistory } from "./review-history.js";
import { validateVerdictPolicy } from "./review-policy-validator.js";
import { buildRevisionRequest } from "./revision-request-builder.js";
import { buildDecisionEvent } from "./decision-event-builder.js";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";

import { loadTrustedConfig } from "../config/config-loader.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";

export interface SubmitWebVerdictOptions {
  runId: string;
  stateDirectory: string;
  configPath: string;
  verdictPath: string;
  githubClient?: GitHubAttestationClient;
  now?: () => Date;
  secrets?: string[];
}

export interface GetWebReviewStatusOptions {
  runId: string;
  stateDirectory: string;
  round?: number;
}

function currentIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

/**
 * Ingest, validate, and process a Web review verdict for Phase 7.
 */
export async function submitWebVerdict(
  options: SubmitWebVerdictOptions
): Promise<WebReviewReceipt> {
  const { runId, stateDirectory, configPath, verdictPath, now } = options;
  const timestamp = currentIso(now);

  // 1. Load trusted config and resolve trusted repo path
  const configResult = await loadTrustedConfig(configPath);
  const repoEntries = Object.values(configResult.repositories);
  if (repoEntries.length === 0 || !repoEntries[0]?.path) {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", "Trusted repository path missing in configuration.");
  }
  const trustedRepoPath = repoEntries[0].path;

  // Resolve mandatory GitHub attestation client
  let effectiveGithubClient: GitHubAttestationClient | undefined = options.githubClient;
  if (!effectiveGithubClient) {
    const githubConfig = configResult.github_pull_request;
    if (!githubConfig) {
      throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", "github_pull_request configuration missing in config.");
    }
    const tokenKey = githubConfig.authentication.token_environment_key;
    const token = process.env[tokenKey];
    if (!token) {
      throw new WebReviewError("WEB_REVIEW_AUTH_ERROR", `GitHub token environment variable '${tokenKey}' is missing. Fresh attestation is mandatory.`);
    }
    effectiveGithubClient = new GitHubRestAttestationClient(token);
  }

  // 2. Load Result Bundle & ingested verdict to resolve round paths
  const bundle = await loadAndVerifyResultBundle(stateDirectory, runId);
  const ingestedVerdict = await readAndCanonicalizeVerdict(verdictPath);
  const rawVerdictObj = ingestedVerdict.parsedVerdict as any;
  const reviewRound = typeof rawVerdictObj?.review_round === "number" ? rawVerdictObj.review_round : 1;

  const paths = resolveReviewRoundPaths(stateDirectory, runId, reviewRound);

  // 3. Acquire per-round exclusive write-ahead lock FIRST
  const lock = await acquireReviewLock(paths.lockPath);
  let receipt: WebReviewReceipt | null = null;

  try {
    // 4. In-lock idempotency check after lock acquisition
    const idempotency = await checkRoundIdempotency(stateDirectory, runId, reviewRound, ingestedVerdict.verdictSha256);
    if (idempotency.isIdempotent && idempotency.existingReceipt) {
      // Verify verdict artifact bytes match incoming verdict exactly
      if (!idempotency.existingVerdictBuffer || !idempotency.existingVerdictBuffer.equals(ingestedVerdict.canonicalBuffer)) {
        throw new WebReviewError(
          "WEB_REVIEW_ALREADY_SEALED",
          `Review round ${reviewRound} is already sealed with different verdict content.`
        );
      }
      return idempotency.existingReceipt;
    }

    receipt = {
      phase_version: "1.1",
      run_id: runId,
      review_mode: reviewRound === 1 ? "INITIAL" : "REVISION",
      review_round: reviewRound,
      state: "READY_TO_VALIDATE",
      phase6_receipt_sha256: bundle.phase6ReceiptSha256,
      result_bundle_sha256: bundle.receipt.archive_sha256!,
      manifest_sha256: bundle.receipt.manifest_sha256!,
      reviewed_entry_set_sha256: bundle.receipt.reviewed_entry_set_sha256!,
      spec_set_sha256: bundle.receipt.spec_set_sha256!,
      verdict_sha256: ingestedVerdict.verdictSha256,
      published_commit_sha: bundle.receipt.published_commit_sha,
      pull_request_number: bundle.receipt.pull_request.number,
      observed_head_sha: bundle.receipt.pull_request.head_sha,
      fresh_attested_head_sha: null,
      fresh_attested_base_branch: null,
      previous_result_bundle_sha256: rawVerdictObj?.previous_result_bundle_sha256 ?? null,
      previous_verdict_sha256: rawVerdictObj?.previous_verdict_sha256 ?? null,
      previous_published_commit_sha: rawVerdictObj?.previous_published_commit_sha ?? null,
      previous_pr_head_sha: rawVerdictObj?.previous_pr_head_sha ?? null,
      revision_request_sha256: null,
      decision_event_sha256: null,
      action: null,
      artifact_paths: {
        verdict: path.relative(path.resolve(stateDirectory), paths.verdictPath).replace(/\\/g, "/"),
        receipt: path.relative(path.resolve(stateDirectory), paths.receiptPath).replace(/\\/g, "/"),
        decision_event: null,
        revision_request: null,
        lock: path.relative(path.resolve(stateDirectory), paths.lockPath).replace(/\\/g, "/"),
      },
      warnings: [],
      errors: [],
      created_at: timestamp,
      updated_at: timestamp,
      validated_at: null,
      completed_at: null,
    };

    // Write write-ahead receipt: READY_TO_VALIDATE
    await writeWebReviewReceipt(paths.receiptPath, receipt);

    // Transition state: VALIDATING
    receipt.state = "VALIDATING";
    receipt.updated_at = currentIso(now);
    await writeWebReviewReceipt(paths.receiptPath, receipt);

    // 5. Review history validation
    const historyResult = await validateReviewHistory(stateDirectory, runId, reviewRound, rawVerdictObj, bundle);

    // 6. Verdict policy validation in trusted repository worktree
    const validatedVerdict = await validateVerdictPolicy(
      rawVerdictObj,
      bundle,
      reviewRound,
      historyResult.previousRevisionRequestData,
      historyResult.previousVerdictData,
      trustedRepoPath
    );

    // 7. Mandatory fresh read-only GitHub attestation immediately before decision
    let prRaw: any;
    try {
      const owner = bundle.receipt.pull_request.url.split("/")[3] || "owner";
      const repoName = bundle.receipt.pull_request.url.split("/")[4] || "repo";
      prRaw = await effectiveGithubClient.getPullRequest(owner, repoName, bundle.receipt.pull_request.number);
    } catch (err: any) {
      throw new WebReviewError(
        err?.code === "RESULT_PR_API_FAILED" ? "WEB_REVIEW_NETWORK_ERROR" : "WEB_REVIEW_NETWORK_ERROR",
        `Fresh GitHub PR attestation failed: ${err.message ?? String(err)}`
      );
    }

    if (!prRaw || typeof prRaw !== "object") {
      throw new WebReviewError("WEB_REVIEW_NETWORK_ERROR", "Invalid GitHub API response.");
    }

    if (prRaw.merged || prRaw.state !== "open") {
      throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `PR #${bundle.receipt.pull_request.number} is closed or merged.`);
    }

    if (prRaw.number !== bundle.receipt.pull_request.number) {
      throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `PR number mismatch: GitHub #${prRaw.number}, receipt #${bundle.receipt.pull_request.number}`);
    }

    if (prRaw.head?.ref && prRaw.head.ref !== bundle.receipt.pull_request.head_branch) {
      throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `PR head branch mismatch: GitHub '${prRaw.head.ref}', receipt '${bundle.receipt.pull_request.head_branch}'`);
    }

    if (prRaw.base?.ref && prRaw.base.ref !== bundle.receipt.pull_request.base_branch) {
      throw new WebReviewError("WEB_REVIEW_REPOSITORY_DRIFT", `PR base branch mismatch: GitHub '${prRaw.base.ref}', receipt '${bundle.receipt.pull_request.base_branch}'`);
    }

    const freshHeadSha = prRaw.head?.sha;
    const freshBaseBranch = prRaw.base?.ref;

    receipt.fresh_attested_head_sha = freshHeadSha || null;
    receipt.fresh_attested_base_branch = freshBaseBranch || null;

    if (freshHeadSha !== validatedVerdict.observed_head_sha) {
      throw new WebReviewError(
        "WEB_REVIEW_REPOSITORY_DRIFT",
        `Repository drift detected: GitHub PR head SHA '${freshHeadSha}' does not match verdict observed head SHA '${validatedVerdict.observed_head_sha}'.`
      );
    }

    if (freshHeadSha !== bundle.receipt.published_commit_sha) {
      throw new WebReviewError(
        "WEB_REVIEW_REPOSITORY_DRIFT",
        `Repository drift detected: GitHub PR head SHA '${freshHeadSha}' does not match Phase 6 published commit '${bundle.receipt.published_commit_sha}'.`
      );
    }

    // Transition state: VALIDATED
    receipt.state = "VALIDATED";
    receipt.validated_at = currentIso(now);
    receipt.updated_at = currentIso(now);
    await writeWebReviewReceipt(paths.receiptPath, receipt);

    // 8. Persist canonical verdict file (`web-review-verdict.json`)
    await writeCanonicalArtifact(paths.verdictPath, ingestedVerdict.canonicalBuffer);

    // 9. Build and persist revision request if REVISE
    let revisionRequestSha256: string | null = null;
    if (validatedVerdict.verdict === "REVISE") {
      const builtRevReq = buildRevisionRequest(validatedVerdict, ingestedVerdict.verdictSha256);
      revisionRequestSha256 = builtRevReq.revisionRequestSha256;
      await writeCanonicalArtifact(paths.revisionRequestPath, builtRevReq.canonicalBuffer);
      receipt.revision_request_sha256 = revisionRequestSha256;
      receipt.artifact_paths.revision_request = path.relative(path.resolve(stateDirectory), paths.revisionRequestPath).replace(/\\/g, "/");
    }

    // 10. Build and persist decision event (`decision-event.json`)
    const builtEvent = buildDecisionEvent(
      validatedVerdict,
      ingestedVerdict.verdictSha256,
      revisionRequestSha256,
      receipt.validated_at
    );
    await writeCanonicalArtifact(paths.decisionEventPath, builtEvent.canonicalBuffer);
    receipt.decision_event_sha256 = builtEvent.decisionEventSha256;
    receipt.artifact_paths.decision_event = path.relative(path.resolve(stateDirectory), paths.decisionEventPath).replace(/\\/g, "/");

    // 11. Terminal state & action assignment
    if (validatedVerdict.verdict === "APPROVE") {
      receipt.state = "APPROVED";
      receipt.action = "ASK_USER_TO_MERGE";
    } else if (validatedVerdict.verdict === "REVISE") {
      receipt.state = "REVISION_REQUESTED";
      receipt.action = "NO_USER_MERGE_PROMPT";
    } else {
      receipt.state = "ESCALATED";
      receipt.action = "NOTIFY_USER_EXCEPTION";
    }

    receipt.completed_at = currentIso(now);
    receipt.updated_at = currentIso(now);

    // Persist final receipt
    await writeWebReviewReceipt(paths.receiptPath, receipt);
    return receipt;
  } catch (error) {
    const code = error instanceof WebReviewError ? error.code : "WEB_REVIEW_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    if (receipt) {
      const isPolicyError = code.startsWith("WEB_REVIEW_") && code !== "WEB_REVIEW_OPERATIONAL_ERROR" && code !== "WEB_REVIEW_NETWORK_ERROR" && code !== "WEB_REVIEW_AUTH_ERROR";
      receipt.state = isPolicyError ? "BLOCKED" : "FAILED";
      receipt.errors.push({ code, message });
      receipt.updated_at = currentIso(now);

      await writeWebReviewReceipt(paths.receiptPath, receipt).catch(() => undefined);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Get read-only status of Phase 7 Web Review. Performs NO validation or network access.
 */
export async function getWebReviewStatus(
  options: GetWebReviewStatusOptions
): Promise<WebReviewReceipt | null> {
  const { runId, stateDirectory, round } = options;

  let targetRound = round;
  if (!targetRound) {
    // Find latest existing round from 4 down to 1
    for (let r = 4; r >= 1; r--) {
      const paths = resolveReviewRoundPaths(stateDirectory, runId, r);
      const existing = await readWebReviewReceipt(paths.receiptPath);
      if (existing) {
        targetRound = r;
        break;
      }
    }
    if (!targetRound) targetRound = 1;
  }

  const paths = resolveReviewRoundPaths(stateDirectory, runId, targetRound);
  return readWebReviewReceipt(paths.receiptPath);
}
