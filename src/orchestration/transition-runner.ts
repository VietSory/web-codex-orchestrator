import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../web-authority/authority-service.js";
import { createProductionExecutorGates } from "../executor/production-gates.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import { checkpointAttempt, completeAttempt, ensureRunLedger, failAttempt } from "./controller.js";
import { deriveNextTransition, type PlannedTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { readSelectedArtifact, selectRegisteredArtifact } from "./artifact-binding.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { publishReadyExecutorSnapshot } from "./p10-publish.js";
import { openDraftPullRequestForExecutorSnapshot } from "./draft-pr.js";
import { recoverCompletedAttempt } from "./recovery.js";
import { withTransitionExecutionLock } from "./run-lock.js";
import { OrchestrationError, type RunLedger } from "./contracts.js";

export interface ContinueInputs { web_pack_path?: string; }
export interface ContinueResult { ledger: RunLedger; planned: PlannedTransition; progressed: boolean; needs_input: string | null; }
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
};
function errorCode(error: unknown): string { if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code; return "ORCHESTRATION_OPERATIONAL_ERROR"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function runNextTransition(options: { runId: string; stateDirectory: string; configPath: string; inputs?: ContinueInputs; dependencies?: Partial<OrchestrationDependencies>; now?: () => Date }): Promise<ContinueResult> {
  return await withTransitionExecutionLock(options.stateDirectory, options.runId, async () => {
    const deps = { ...productionDependencies, ...options.dependencies }; const now = options.now ?? (() => new Date()); let ledger = await ensureRunLedger(options.stateDirectory, options.runId, now());
    ledger = await recoverCompletedAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, configPath: options.configPath, ledger, now });
    const snapshot = await deps.readSnapshot(options.stateDirectory, options.runId); const planned = deriveNextTransition(snapshot);
    if (ledger.paused) return { ledger, planned, progressed: false, needs_input: "resume" };
    if (["WAIT_WEB_VERDICT", "WAIT_HUMAN", "DONE", "PACKAGE_RESULT", "REVISE"].includes(planned.transition)) return { ledger, planned, progressed: false, needs_input: null };
    if (planned.transition === "REGISTER_WEB_PACK" && !options.inputs?.web_pack_path) return { ledger, planned, progressed: false, needs_input: "web_pack_path" };
    let activeAttemptId: string | null = null; let operationFailed = false;
    try {
      if (planned.transition === "REGISTER_WEB_PACK") { const pack = await deps.readPack(options.inputs!.web_pack_path!); ledger = await checkpointAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, transition: "REGISTER_WEB_PACK", payload: { archive_sha256: pack.archive_sha256, pack_id: pack.manifest.pack_id }, now: now() }); activeAttemptId = ledger.current_attempt!.attempt_id; const registration = await deps.registerPack({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, archivePath: options.inputs!.web_pack_path! }); if (registration.artifact_sha256 !== pack.archive_sha256) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_DRIFT", "Registered Web pack SHA differs from the sealed transition request."); await deps.selectArtifact({ stateDirectory: options.stateDirectory, runId: options.runId, artifactSha256: registration.artifact_sha256, now: now() }); ledger = await completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: activeAttemptId, result: { artifact_sha256: registration.artifact_sha256, manifest_sha256: registration.manifest_sha256 }, nextTransition: "EXECUTE_REGISTERED_PACK", now: now() }); }
      else if (planned.transition === "EXECUTE_REGISTERED_PACK") { const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId); if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists."); ledger = await checkpointAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, transition: "EXECUTE_REGISTERED_PACK", payload: { artifact_sha256: registration.artifact_sha256, manifest_sha256: registration.manifest_sha256 }, now: now() }); activeAttemptId = ledger.current_attempt!.attempt_id; const gates = await deps.createExecutorGates({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath }); const receipt = await deps.executePack({ runId: options.runId, artifactSha256: registration.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath, verifier: gates.verifier, reviewer: gates.reviewer }); const next = receipt.state === "READY_FOR_PUBLISH" ? "PUBLISH" : receipt.state === "ESCALATE_TO_WEB" ? "REGISTER_WEB_PACK" : "WAIT_HUMAN"; ledger = await completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: activeAttemptId, result: { state: receipt.state, change_set_digest: receipt.change_set_digest, artifact_sha256: receipt.artifact_sha256 }, nextTransition: next, now: now() }); }
      else if (planned.transition === "PUBLISH") { const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId); if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists."); const ready = await deps.attestReadyExecutor({ runId: options.runId, artifactSha256: registration.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath }); ledger = await checkpointAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, transition: "PUBLISH", payload: { artifact_sha256: registration.artifact_sha256, change_set_digest: ready.changeSetDigest }, now: now() }); activeAttemptId = ledger.current_attempt!.attempt_id; const publish = await deps.publishReadyExecutor({ runId: options.runId, artifactSha256: registration.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath, now }); if (publish.state !== "PUSHED" || publish.commit_sha === null || publish.remote_branch_sha !== publish.commit_sha) throw new OrchestrationError("ORCHESTRATION_PUBLISH_INCOMPLETE", "Publication ended without an exact verified PUSHED commit."); ledger = await completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: activeAttemptId, result: { state: publish.state, commit_sha: publish.commit_sha, remote_branch_sha: publish.remote_branch_sha }, nextTransition: "OPEN_DRAFT_PR", now: now() }); }
      else if (planned.transition === "OPEN_DRAFT_PR") { const registration = await deps.readSelectedArtifact(options.stateDirectory, options.runId); if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No selected registered Web pack exists."); const ready = await deps.attestReadyExecutor({ runId: options.runId, artifactSha256: registration.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath }); ledger = await checkpointAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, transition: "OPEN_DRAFT_PR", payload: { artifact_sha256: registration.artifact_sha256, change_set_digest: ready.changeSetDigest }, now: now() }); activeAttemptId = ledger.current_attempt!.attempt_id; const draft = await deps.openDraftPr({ runId: options.runId, artifactSha256: registration.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath, now }); if (draft.state !== "OPEN" || draft.observed_draft !== true || draft.observed_state !== "open" || draft.observed_head_sha !== draft.expected_head_sha || draft.pull_number === null) throw new OrchestrationError("ORCHESTRATION_DRAFT_PR_INCOMPLETE", "Draft PR operation ended without an exact open Draft PR receipt."); ledger = await completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: activeAttemptId, result: { state: draft.state, pull_number: draft.pull_number, expected_head_sha: draft.expected_head_sha, request_sha256: draft.request_sha256 }, nextTransition: "PACKAGE_RESULT", now: now() }); }
    } catch (error) { const current = await ensureRunLedger(options.stateDirectory, options.runId, now()); if (activeAttemptId && current.current_attempt?.status === "STARTED" && current.current_attempt.attempt_id === activeAttemptId) { ledger = await failAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: activeAttemptId, failureCode: errorCode(error), message: errorMessage(error), now: now() }); operationFailed = true; } else throw error; }
    const afterSnapshot = await deps.readSnapshot(options.stateDirectory, options.runId); const afterPlan = deriveNextTransition(afterSnapshot); const blockedByFailure = operationFailed || ["WAITING", "BLOCKED", "PAUSED", "FAILED"].includes(ledger.status); return { ledger, planned: afterPlan, progressed: !blockedByFailure, needs_input: !blockedByFailure && afterPlan.transition === "REGISTER_WEB_PACK" ? "web_pack_path" : null };
  });
}
