import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../web-authority/authority-service.js";
import { createProductionExecutorGates } from "../executor/production-gates.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import { readAndCanonicalizeVerdict } from "../web-review/verdict-source-reader.js";
import { checkpointAttempt, completeAttempt, ensureRunLedger, failAttempt } from "./controller.js";
import { deriveNextTransition, type PlannedTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { readSelectedArtifact, selectRegisteredArtifact } from "./artifact-binding.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { publishReadyExecutorSnapshot } from "./p10-publish.js";
import { openDraftPullRequestForExecutorSnapshot } from "./draft-pr.js";
import { packageResultForRun } from "./package-result.js";
import { submitAttestedWebVerdict } from "./web-verdict.js";
import {
  assertRevisionResultForOrchestration,
  attestRevisionAuthorityForOrchestration,
  revisionOrchestrationPayload,
  revisionOrchestrationUsage,
  reviseRunForOrchestration,
} from "./revise.js";
import { recoverCompletedAttempt } from "./recovery.js";
import { withTransitionExecutionLock } from "./run-lock.js";
import { OrchestrationError, type RunLedger } from "./contracts.js";

export interface ContinueInputs {
  web_pack_path?: string;
  web_verdict_path?: string;
}

export interface ContinueResult {
  ledger: RunLedger;
  planned: PlannedTransition;
  progressed: boolean;
  needs_input: string | null;
}

export interface OrchestrationDependencies {
  readSnapshot: typeof readLifecycleSnapshot;
  readPack: typeof readAndValidateWebImplementationPack;
  registerPack: typeof registerWebImplementationPack;
  selectArtifact: typeof selectRegisteredArtifact;
  readSelectedArtifact: typeof readSelectedArtifact;
  createExecutorGates: typeof createProductionExecutorGates;
  executePack: typeof executeRegisteredWebPack;
  attestReadyExecutor: typeof attestReadyExecutorSnapshot;
  publishReadyExecutor: typeof publishReadyExecutorSnapshot;
  openDraftPr: typeof openDraftPullRequestForExecutorSnapshot;
  packageResult: typeof packageResultForRun;
  readVerdict: typeof readAndCanonicalizeVerdict;
  submitWebVerdict: typeof submitAttestedWebVerdict;
  attestRevisionAuthority: typeof attestRevisionAuthorityForOrchestration;
  reviseRun: typeof reviseRunForOrchestration;
}

const productionDependencies: OrchestrationDependencies = {
  readSnapshot: readLifecycleSnapshot,
  readPack: readAndValidateWebImplementationPack,
  registerPack: registerWebImplementationPack,
  selectArtifact: selectRegisteredArtifact,
  readSelectedArtifact,
  createExecutorGates: createProductionExecutorGates,
  executePack: executeRegisteredWebPack,
  attestReadyExecutor: attestReadyExecutorSnapshot,
  publishReadyExecutor: publishReadyExecutorSnapshot,
  openDraftPr: openDraftPullRequestForExecutorSnapshot,
  packageResult: packageResultForRun,
  readVerdict: readAndCanonicalizeVerdict,
  submitWebVerdict: submitAttestedWebVerdict,
  attestRevisionAuthority: attestRevisionAuthorityForOrchestration,
  reviseRun: reviseRunForOrchestration,
};

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "ORCHESTRATION_OPERATIONAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runNextTransition(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  inputs?: ContinueInputs;
  dependencies?: Partial<OrchestrationDependencies>;
  now?: () => Date;
}): Promise<ContinueResult> {
  return await withTransitionExecutionLock(options.stateDirectory, options.runId, async () => {
    const deps = { ...productionDependencies, ...options.dependencies };
    const now = options.now ?? (() => new Date());
    let ledger = await ensureRunLedger(options.stateDirectory, options.runId, now());
    ledger = await recoverCompletedAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      configPath: options.configPath,
      ledger,
      now,
    });

    const snapshot = await deps.readSnapshot(options.stateDirectory, options.runId);
    const planned = deriveNextTransition(snapshot);
    if (ledger.paused) return { ledger, planned, progressed: false, needs_input: "resume" };
    if (["BLOCKED", "FAILED", "COMPLETE"].includes(ledger.status)) {
      return { ledger, planned, progressed: false, needs_input: null };
    }
    if (["WAIT_HUMAN", "DONE"].includes(planned.transition)) {
      return { ledger, planned, progressed: false, needs_input: null };
    }
    if (
      !ledger.current_attempt &&
      ledger.retry.next_retry_at &&
      Date.parse(ledger.retry.next_retry_at) > now().getTime()
    ) {
      return { ledger, planned, progressed: false, needs_input: null };
    }
    if (planned.transition === "REGISTER_WEB_PACK" && !options.inputs?.web_pack_path) {
      return { ledger, planned, progressed: false, needs_input: "web_pack_path" };
    }
    if (planned.transition === "WAIT_WEB_VERDICT" && !options.inputs?.web_verdict_path) {
      return { ledger, planned, progressed: false, needs_input: "web_verdict_path" };
    }

    let activeAttemptId: string | null = null;
    let operationFailed = false;
    try {
      if (planned.transition === "REGISTER_WEB_PACK") {
        const pack = await deps.readPack(options.inputs!.web_pack_path!);
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "REGISTER_WEB_PACK",
          payload: { archive_sha256: pack.archive_sha256, pack_id: pack.manifest.pack_id },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const registration = await deps.registerPack({
          runId: options.runId,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          archivePath: options.inputs!.web_pack_path!,
        });
        if (registration.artifact_sha256 !== pack.archive_sha256) {
          throw new OrchestrationError("ORCHESTRATION_ARTIFACT_DRIFT", "Registered Web pack SHA differs from the sealed transition request.");
        }
        await deps.selectArtifact({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          now: now(),
        });
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: { artifact_sha256: registration.artifact_sha256, manifest_sha256: registration.manifest_sha256 },
          nextTransition: "EXECUTE_REGISTERED_PACK",
          now: now(),
        });
      } else if (planned.transition === "EXECUTE_REGISTERED_PACK") {
        const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
        if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists.");
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "EXECUTE_REGISTERED_PACK",
          payload: { artifact_sha256: registration.artifact_sha256, manifest_sha256: registration.manifest_sha256 },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const gates = await deps.createExecutorGates({
          runId: options.runId,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
        });
        const receipt = await deps.executePack({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          verifier: gates.verifier,
          reviewer: gates.reviewer,
        });
        const next = receipt.state === "READY_FOR_PUBLISH"
          ? "PUBLISH"
          : receipt.state === "ESCALATE_TO_WEB"
            ? "REGISTER_WEB_PACK"
            : "WAIT_HUMAN";
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: { state: receipt.state, change_set_digest: receipt.change_set_digest, artifact_sha256: receipt.artifact_sha256 },
          nextTransition: next,
          now: now(),
        });
      } else if (planned.transition === "PUBLISH") {
        const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
        if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists.");
        const ready = await deps.attestReadyExecutor({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
        });
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "PUBLISH",
          payload: { artifact_sha256: registration.artifact_sha256, change_set_digest: ready.changeSetDigest },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const publish = await deps.publishReadyExecutor({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          now,
        });
        if (publish.state !== "PUSHED" || publish.commit_sha === null || publish.remote_branch_sha !== publish.commit_sha) {
          throw new OrchestrationError("ORCHESTRATION_PUBLISH_INCOMPLETE", "Publication ended without an exact verified PUSHED commit.");
        }
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: { state: publish.state, commit_sha: publish.commit_sha, remote_branch_sha: publish.remote_branch_sha },
          nextTransition: "OPEN_DRAFT_PR",
          now: now(),
        });
      } else if (planned.transition === "OPEN_DRAFT_PR") {
        const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
        if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists.");
        const ready = await deps.attestReadyExecutor({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
        });
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "OPEN_DRAFT_PR",
          payload: { artifact_sha256: registration.artifact_sha256, change_set_digest: ready.changeSetDigest },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const draft = await deps.openDraftPr({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          now,
        });
        if (
          draft.state !== "OPEN" ||
          draft.observed_draft !== true ||
          draft.observed_state !== "open" ||
          draft.observed_head_sha !== draft.expected_head_sha ||
          draft.pull_number === null
        ) {
          throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_INCOMPLETE", "Draft PR operation ended without an exact open Draft PR receipt.");
        }
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: {
            state: draft.state,
            pull_number: draft.pull_number,
            expected_head_sha: draft.expected_head_sha,
            request_sha256: draft.request_sha256,
          },
          nextTransition: "PACKAGE_RESULT",
          now: now(),
        });
      } else if (planned.transition === "PACKAGE_RESULT") {
        const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
        if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists.");
        const ready = await deps.attestReadyExecutor({
          runId: options.runId,
          artifactSha256: registration.artifact_sha256,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
        });
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "PACKAGE_RESULT",
          payload: { artifact_sha256: registration.artifact_sha256, change_set_digest: ready.changeSetDigest },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const result = await deps.packageResult({
          runId: options.runId,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          now,
        });
        if (
          result.state !== "READY_FOR_WEB_REVIEW" ||
          result.run_id !== options.runId ||
          result.archive_sha256 === null ||
          result.change_set_sha256 !== ready.changeSetDigest ||
          result.published_commit_sha !== result.remote_branch_sha ||
          result.pull_request.draft !== true ||
          result.pull_request.head_sha !== result.published_commit_sha
        ) {
          throw new OrchestrationError("ORCHESTRATION_RESULT_INCOMPLETE", "Result Bundle operation ended without an exact verified Draft-PR-bound handoff.");
        }
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: {
            state: result.state,
            archive_sha256: result.archive_sha256,
            published_commit_sha: result.published_commit_sha,
            pull_number: result.pull_request.number,
            reviewed_entry_set_sha256: result.reviewed_entry_set_sha256,
          },
          nextTransition: "WAIT_WEB_VERDICT",
          now: now(),
        });
      } else if (planned.transition === "WAIT_WEB_VERDICT") {
        const ingested = await deps.readVerdict(options.inputs!.web_verdict_path!);
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "WAIT_WEB_VERDICT",
          payload: { verdict_sha256: ingested.verdictSha256 },
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const review = await deps.submitWebVerdict({
          runId: options.runId,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          ingestedVerdict: ingested,
          now,
        });
        if (
          review.verdict_sha256 !== ingested.verdictSha256 ||
          review.run_id !== options.runId ||
          !["APPROVED", "REVISION_REQUESTED", "ESCALATED"].includes(review.state) ||
          review.fresh_attested_head_sha === null ||
          review.fresh_attested_head_sha !== review.published_commit_sha ||
          review.decision_event_sha256 === null
        ) {
          throw new OrchestrationError("ORCHESTRATION_WEB_VERDICT_INCOMPLETE", "Web verdict processing did not produce an exact sealed terminal decision for the freshly attested Draft PR head.");
        }
        const next = review.state === "REVISION_REQUESTED" ? "REVISE" : "WAIT_HUMAN";
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: {
            state: review.state,
            review_round: review.review_round,
            verdict_sha256: review.verdict_sha256,
            decision_event_sha256: review.decision_event_sha256,
            revision_request_sha256: review.revision_request_sha256,
            published_commit_sha: review.published_commit_sha,
            pull_request_number: review.pull_request_number,
            fresh_attested_head_sha: review.fresh_attested_head_sha,
          },
          nextTransition: next,
          now: now(),
        });
      } else if (planned.transition === "REVISE") {
        const authority = await deps.attestRevisionAuthority({
          runId: options.runId,
          stateDirectory: options.stateDirectory,
        });
        ledger = await checkpointAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          transition: "REVISE",
          payload: revisionOrchestrationPayload(authority),
          now: now(),
        });
        activeAttemptId = ledger.current_attempt!.attempt_id;
        const revision = await deps.reviseRun({
          runId: options.runId,
          revisionRound: authority.revisionRound,
          stateDirectory: options.stateDirectory,
          configPath: options.configPath,
          now,
        });
        assertRevisionResultForOrchestration(options.runId, revision, authority);
        ledger = await completeAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          result: {
            state: revision.state,
            revision_round: revision.revision_round,
            previous_pr_head_sha: revision.previous_pr_head_sha,
            new_published_commit_sha: revision.new_published_commit_sha,
            remote_branch_sha: revision.remote_branch_sha,
            pull_request_number: revision.pull_request_number,
            result_bundle_sha256: revision.result_bundle_sha256,
            result_manifest_sha256: revision.result_manifest_sha256,
            next_review_round: revision.next_review_round,
          },
          nextTransition: "WAIT_WEB_VERDICT",
          usage: revisionOrchestrationUsage(revision),
          now: now(),
        });
      }
    } catch (error) {
      const current = await ensureRunLedger(options.stateDirectory, options.runId, now());
      if (
        activeAttemptId &&
        current.current_attempt?.status === "STARTED" &&
        current.current_attempt.attempt_id === activeAttemptId
      ) {
        ledger = await failAttempt({
          stateDirectory: options.stateDirectory,
          runId: options.runId,
          attemptId: activeAttemptId,
          failureCode: errorCode(error),
          message: errorMessage(error),
          now: now(),
        });
        operationFailed = true;
      } else {
        throw error;
      }
    }

    const afterSnapshot = await deps.readSnapshot(options.stateDirectory, options.runId);
    const afterPlan = deriveNextTransition(afterSnapshot);
    const blockedByFailure = operationFailed || ["BLOCKED", "PAUSED", "FAILED"].includes(ledger.status);
    const needsInput = !blockedByFailure && afterPlan.transition === "REGISTER_WEB_PACK"
      ? "web_pack_path"
      : !blockedByFailure && afterPlan.transition === "WAIT_WEB_VERDICT"
        ? "web_verdict_path"
        : null;
    return { ledger, planned: afterPlan, progressed: !blockedByFailure, needs_input: needsInput };
  });
}
