// Core orchestrator for Phase 7 Web Review Verdict Processing
import path from "node:path";
import { WebReviewError } from "./contracts.js";
import type { WebReviewReceipt } from "./contracts.js";
import {
  prepareReviewRoundDirectory,
  resolveReviewRoundPaths,
  reviewRoundDirectoryExistsAndIsSafe,
} from "./web-review-paths.js";
import { acquireReviewLock } from "./web-review-lock.js";
import {
  MAX_RECEIPT_DIAGNOSTIC_CHARS,
  MAX_RECEIPT_ERRORS,
  readWebReviewReceipt,
  writeWebReviewReceipt,
  writeCanonicalArtifact,
} from "./web-review-store.js";
import { readAndCanonicalizeVerdict } from "./verdict-source-reader.js";
import { loadAndVerifyResultBundle } from "./result-bundle-review-reader.js";
import { validateReviewHistory } from "./review-history.js";
import { validateVerdictPolicy } from "./review-policy-validator.js";
import { buildRevisionRequest } from "./revision-request-builder.js";
import { buildDecisionEvent } from "./decision-event-builder.js";
import { resolveTrustedRunContext } from "./trusted-run-context.js";
import { verifyGitHubAttestation } from "./github-review-attestation.js";
import { inspectReviewPersistence } from "./review-recovery.js";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";

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

function boundedDiagnostic(value: string): string {
  return value.length <= MAX_RECEIPT_DIAGNOSTIC_CHARS
    ? value
    : `${value.slice(0, MAX_RECEIPT_DIAGNOSTIC_CHARS - 1)}…`;
}

function appendBoundedReceiptError(receipt: WebReviewReceipt, code: string, message: string): void {
  const next = {
    code: boundedDiagnostic(code).slice(0, 256),
    message: boundedDiagnostic(message),
  };
  receipt.errors = [...receipt.errors.slice(-(MAX_RECEIPT_ERRORS - 1)), next];
}

/** Ingest, validate, and process a Web review verdict for Phase 7. */
export async function submitWebVerdict(
  options: SubmitWebVerdictOptions
): Promise<WebReviewReceipt> {
  const { runId, stateDirectory, configPath, verdictPath, now, githubClient } = options;
  const timestamp = currentIso(now);

  // 1. Resolve exact trusted repository context from the canonical run receipt.
  const runCtx = await resolveTrustedRunContext(runId, stateDirectory, configPath);
  const trustedRepoPath = runCtx.trustedRepoPath;

  // 2. Independently verify the exact Result Bundle and ingest the untrusted verdict.
  const bundle = await loadAndVerifyResultBundle(stateDirectory, runId);
  const ingestedVerdict = await readAndCanonicalizeVerdict(verdictPath);
  const rawVerdictObj = ingestedVerdict.parsedVerdict as any;
  const reviewRound = typeof rawVerdictObj?.review_round === "number" ? rawVerdictObj.review_round : 1;

  // The exact schemas/contracts used below came from this verified Result Bundle.
  const embeddedContracts = bundle.embeddedContracts;
  const paths = resolveReviewRoundPaths(stateDirectory, runId, reviewRound);
  await prepareReviewRoundDirectory(stateDirectory, paths.roundDir);

  // 3. Acquire the per-round exclusive lock before inspecting or mutating round state.
  const lock = await acquireReviewLock(paths.lockPath);
  let receipt: WebReviewReceipt | null = null;

  try {
    // 4. Validate persisted state and support exact, integrity-checked idempotent retry.
    const inspection = await inspectReviewPersistence(paths.roundDir, ingestedVerdict.verdictSha256);
    if (inspection.existingReceipt) {
      const ex = inspection.existingReceipt;
      if (ex.state === "APPROVED" || ex.state === "REVISION_REQUESTED" || ex.state === "ESCALATED") {
        if (!inspection.verdictMatches) {
          throw new WebReviewError(
            "WEB_REVIEW_ALREADY_SEALED",
            `Review round ${reviewRound} is already sealed with a different verdict.`
          );
        }

        // Idempotency never means stale GitHub authority. Re-validate the exact
        // stored verdict against the exact current bundle/history and perform a
        // fresh read-only GitHub attestation before returning any terminal action.
        if (!embeddedContracts.compiledVerdictValidator(rawVerdictObj)) {
          throw new WebReviewError(
            "WEB_REVIEW_VERDICT_INVALID",
            `Verdict failed exact embedded schema validation on retry: ${embeddedContracts.verdictSchemaErrors() ?? "unknown schema error"}`
          );
        }
        const historyResult = await validateReviewHistory(stateDirectory, runId, reviewRound, rawVerdictObj, bundle);
        const validatedVerdict = await validateVerdictPolicy(
          rawVerdictObj,
          bundle,
          reviewRound,
          historyResult.previousRevisionRequestData,
          historyResult.previousVerdictData,
          trustedRepoPath
        );
        await verifyGitHubAttestation({
          receipt: bundle.receipt,
          config: runCtx.trustedConfig,
          verdict: validatedVerdict,
          githubClient,
        });
        return ex;
      }
      receipt = ex;
    }

    if (!receipt) {
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
        previous_pr_head_sha: null,
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
    }

    await writeWebReviewReceipt(paths.receiptPath, receipt);
    receipt.state = "VALIDATING";
    receipt.updated_at = currentIso(now);
    await writeWebReviewReceipt(paths.receiptPath, receipt);

    // 5. The exact verdict schema embedded in the exact reviewed bundle is authoritative.
    if (!embeddedContracts.compiledVerdictValidator(rawVerdictObj)) {
      throw new WebReviewError(
        "WEB_REVIEW_VERDICT_INVALID",
        `Verdict failed exact embedded schema validation: ${embeddedContracts.verdictSchemaErrors() ?? "unknown schema error"}`
      );
    }

    // 6. Validate immutable review history before policy interpretation.
    const historyResult = await validateReviewHistory(stateDirectory, runId, reviewRound, rawVerdictObj, bundle);

    // 7. Enforce mandatory bindings, semantic rules, locked references and anti-drip policy.
    const validatedVerdict = await validateVerdictPolicy(
      rawVerdictObj,
      bundle,
      reviewRound,
      historyResult.previousRevisionRequestData,
      historyResult.previousVerdictData,
      trustedRepoPath
    );

    // 8. Mandatory fresh, read-only GitHub attestation immediately before dispatch.
    const attestation = await verifyGitHubAttestation({
      receipt: bundle.receipt,
      config: runCtx.trustedConfig,
      verdict: validatedVerdict,
      githubClient,
    });

    receipt.fresh_attested_head_sha = attestation.headSha;
    receipt.fresh_attested_base_branch = attestation.baseBranch;
    receipt.state = "VALIDATED";
    receipt.validated_at = currentIso(now);
    receipt.updated_at = currentIso(now);
    await writeWebReviewReceipt(paths.receiptPath, receipt);

    // 9. Seal the canonical verdict only after all validation and attestation succeeds.
    await writeCanonicalArtifact(paths.verdictPath, ingestedVerdict.canonicalBuffer);

    // 10. REVISE produces the registered, schema-validated Phase 8 handoff request.
    let revisionRequestSha256: string | null = null;
    if (validatedVerdict.verdict === "REVISE") {
      const builtRevReq = buildRevisionRequest(validatedVerdict, ingestedVerdict.verdictSha256);
      revisionRequestSha256 = builtRevReq.revisionRequestSha256;

      if (!embeddedContracts.compiledRevisionRequestValidator(builtRevReq.revisionRequest)) {
        throw new WebReviewError(
          "WEB_REVIEW_OPERATIONAL_ERROR",
          `Generated revision request failed embedded schema validation: ${embeddedContracts.revisionRequestSchemaErrors()}`
        );
      }

      await writeCanonicalArtifact(paths.revisionRequestPath, builtRevReq.canonicalBuffer);
      receipt.revision_request_sha256 = revisionRequestSha256;
      receipt.artifact_paths.revision_request = path.relative(path.resolve(stateDirectory), paths.revisionRequestPath).replace(/\\/g, "/");
    }

    // 11. Seal deterministic decision event.
    const builtEvent = buildDecisionEvent(
      validatedVerdict,
      ingestedVerdict.verdictSha256,
      revisionRequestSha256
    );
    await writeCanonicalArtifact(paths.decisionEventPath, builtEvent.canonicalBuffer);
    receipt.decision_event_sha256 = builtEvent.decisionEventSha256;
    receipt.artifact_paths.decision_event = path.relative(path.resolve(stateDirectory), paths.decisionEventPath).replace(/\\/g, "/");

    // 12. Deterministic terminal dispatch. Phase 7 itself never mutates GitHub.
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
    await writeWebReviewReceipt(paths.receiptPath, receipt);
    return receipt;
  } catch (error) {
    const code = error instanceof WebReviewError ? error.code : "WEB_REVIEW_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    if (receipt) {
      const isPolicyError = code.startsWith("WEB_REVIEW_") && code !== "WEB_REVIEW_OPERATIONAL_ERROR" && code !== "WEB_REVIEW_NETWORK_ERROR" && code !== "WEB_REVIEW_AUTH_ERROR";
      receipt.state = isPolicyError ? "BLOCKED" : "FAILED";
      appendBoundedReceiptError(receipt, code, message);
      receipt.updated_at = currentIso(now);
      await writeWebReviewReceipt(paths.receiptPath, receipt).catch(() => undefined);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

/** Get read-only status. Performs no validation, Git access or network access. */
export async function getWebReviewStatus(
  options: GetWebReviewStatusOptions
): Promise<WebReviewReceipt | null> {
  const { runId, stateDirectory, round } = options;

  let targetRound = round;
  if (!targetRound) {
    for (let r = 4; r >= 1; r--) {
      const paths = resolveReviewRoundPaths(stateDirectory, runId, r);
      if (!(await reviewRoundDirectoryExistsAndIsSafe(stateDirectory, paths.roundDir))) continue;
      const existing = await readWebReviewReceipt(paths.receiptPath);
      if (existing) {
        targetRound = r;
        break;
      }
    }
    if (!targetRound) targetRound = 1;
  }

  const paths = resolveReviewRoundPaths(stateDirectory, runId, targetRound);
  if (!(await reviewRoundDirectoryExistsAndIsSafe(stateDirectory, paths.roundDir))) return null;
  return readWebReviewReceipt(paths.receiptPath);
}
