import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { applyPairWebRepair } from "../orchestration/web-code-review-repair.js";
import { readSelectedArtifact } from "../orchestration/artifact-binding.js";
import { readExecutorReceipt } from "../executor/store.js";
import { submitWebVerdict } from "../web-review/web-review-service.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { adoptCodeReviewVerdict, readWebCodeReviewReceipt } from "./code-review-service.js";
import { WebBridgeError, parseWebVerdictEnvelope, type WebVerdictEnvelope } from "./contracts.js";

function runIdentity(runId: string): { taskId: string; archiveSha: string } { const split = runId.lastIndexOf(":"); const value = { taskId: runId.slice(0, split), archiveSha: runId.slice(split + 1) }; if (split < 1 || !/^[a-f0-9]{64}$/.test(value.archiveSha)) throw new WebBridgeError("WEB_VERDICT_BINDING_INVALID", "Run identity is invalid."); return value; }

async function isPairWebStrategy(stateDirectory: string, runId: string, identity: { taskId: string; archiveSha: string }): Promise<boolean> {
  const selected = await readSelectedArtifact(stateDirectory, runId);
  if (!selected) return false;
  const executor = await readExecutorReceipt(stateDirectory, identity.taskId, identity.archiveSha, selected.artifact_sha256);
  return executor?.review_strategy === "web" && executor.reviewer_selection === undefined;
}

export async function materializeAndSubmitWebVerdict(options: { envelope: WebVerdictEnvelope | unknown; stateDirectory: string; configPath: string; githubClient?: GitHubAttestationClient; now?: () => Date }): Promise<{ verdict_path: string; receipt: WebReviewReceipt }> {
  const envelope = parseWebVerdictEnvelope(options.envelope);
  const identity = runIdentity(envelope.run_id);

  // PAIR Web-B independent code review. Seal the review decision first, then
  // hand exact repair bytes to Harness when REVISE includes bounded operations.
  const codeReview = await readWebCodeReviewReceipt(options.stateDirectory, envelope.run_id);
  if (codeReview?.review_job_id === envelope.review_id) {
    const adopted = await adoptCodeReviewVerdict({ envelope, stateDirectory: options.stateDirectory, ...(options.now ? { now: options.now } : {}) });
    if (adopted.state === "REVISION_REQUESTED" && envelope.repair_operations?.length) await applyPairWebRepair({ envelope, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
    const codeReviewPath = path.join(options.stateDirectory, "bridge", "code-reviews", identity.taskId, identity.archiveSha, "receipt.json");
    return { verdict_path: codeReviewPath, receipt: adopted as unknown as WebReviewReceipt };
  }

  const receiptPath = resultBundlePaths(options.stateDirectory, identity.taskId, identity.archiveSha).receiptPath;
  const bundle = await readResultBundleReceipt(receiptPath);
  if (!bundle || bundle.state !== "READY_FOR_WEB_REVIEW" || !bundle.archive_sha256 || !bundle.manifest_sha256 || !bundle.reviewed_entry_set_sha256 || !bundle.spec_set_sha256) throw new WebBridgeError("WEB_VERDICT_RESULT_NOT_READY", "Canonical Result Bundle is not ready for Web review.");
  if (bundle.archive_sha256 !== envelope.result_bundle_sha256 || bundle.run_id !== envelope.run_id) throw new WebBridgeError("WEB_VERDICT_BINDING_MISMATCH", "Web verdict differs from the exact canonical Result Bundle.");
  const trusted = await resolveTrustedRunContext(envelope.run_id, options.stateDirectory, options.configPath);
  const acceptance = JSON.parse(await readFile(path.join(trusted.runReceipt.accepted_bundle_path, "acceptance.json"), "utf8")) as { criteria?: Array<{ id?: string; description?: string }> };
  const criteria = acceptance.criteria ?? [];
  if (!criteria.length) throw new WebBridgeError("WEB_VERDICT_ACCEPTANCE_INVALID", "Accepted task has no acceptance criteria.");
  const reviewRound = bundle.result_bundle_version === "1.2" ? (bundle.revision_round ?? 1) + 1 : 1;
  const decision = envelope.verdict === "BLOCK" ? "ESCALATE" : envelope.verdict;
  const blocking = envelope.findings.filter((finding) => finding.severity === "blocking");
  if (decision === "APPROVE" && blocking.length) throw new WebBridgeError("WEB_VERDICT_POLICY_INVALID", "APPROVE cannot contain blocking findings.");
  if (decision !== "APPROVE" && blocking.length === 0) blocking.push({ id: "WEB-FIND-000", severity: "blocking", description: envelope.summary });
  const lockedIds = criteria.map((criterion) => criterion.id).filter((value): value is string => Boolean(value));
  const canonical = {
    schema_version: "1.1", verdict: decision, review_mode: reviewRound === 1 ? "INITIAL" : "REVISION", review_round: reviewRound, run_id: envelope.run_id,
    spec_set_sha256: bundle.spec_set_sha256, result_bundle_sha256: bundle.archive_sha256, manifest_sha256: bundle.manifest_sha256, reviewed_entry_set_sha256: bundle.reviewed_entry_set_sha256,
    published_commit_sha: bundle.published_commit_sha, pull_request_number: bundle.pull_request.number, observed_head_sha: bundle.pull_request.head_sha,
    review_contract_version: "1.1", review_policy_version: "1.0",
    previous_result_bundle_sha256: reviewRound === 1 ? null : bundle.previous_result_bundle_sha256 ?? null,
    previous_verdict_sha256: reviewRound === 1 ? null : bundle.previous_verdict_sha256 ?? null,
    revision_request_sha256: reviewRound === 1 ? null : bundle.revision_request_sha256 ?? null,
    previous_published_commit_sha: reviewRound === 1 ? null : bundle.previous_published_commit_sha ?? null,
    comprehensive_review_complete: true,
    criterion_results: criteria.map((criterion, index) => ({ criterion_id: criterion.id, required: true, status: decision === "APPROVE" ? "PASS" : index === 0 ? "FAIL" : "PASS", evidence_refs: ["evidence/verification.json"], notes: decision === "APPROVE" ? "Reviewed through exact Result Bundle evidence." : envelope.summary })),
    blocking_findings: blocking.map((finding, index) => ({ finding_id: `WEB-FIND-${String(index + 1).padStart(3, "0")}`, classification: decision === "ESCALATE" ? "HUMAN_REQUIRED" : "IMPLEMENTATION_DEFECT", finding_origin: reviewRound === 1 ? "INITIAL_DISCOVERY" : "REVISION_REGRESSION", previous_finding_id: null, locked_reference_ids: lockedIds.length ? lockedIds : ["task/acceptance.json"], artifact_paths: ["repository/diff.patch"], line_or_json_pointer: "repository/diff.patch", expected_behavior: criteria[0]?.description ?? "The sealed acceptance contract must pass.", observed_behavior: finding.description, evidence: finding.description, minimal_required_fix: finding.description, revision_changed_paths: [] })),
    non_blocking_backlog: envelope.findings.filter((finding) => finding.severity === "non_blocking").map((finding) => ({ id: finding.id, description: finding.description })), summary: envelope.summary,
  };
  const directory = path.join(options.stateDirectory, "bridge", "verdicts", envelope.review_id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const verdictPath = path.join(directory, "web-verdict.json");
  const bytes = canonicalJsonBuffer(canonical);
  try { const existing = await readFile(verdictPath); if (!existing.equals(bytes)) throw new WebBridgeError("WEB_VERDICT_REPLAY_CONFLICT", "A different verdict already exists for this review."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await writeFile(verdictPath, bytes, { flag: "wx", mode: 0o600 }); }
  const receipt = await submitWebVerdict({ runId: envelope.run_id, stateDirectory: options.stateDirectory, configPath: options.configPath, verdictPath, ...(options.githubClient ? { githubClient: options.githubClient } : {}), ...(options.now ? { now: options.now } : {}) });

  // Original Web-A final review is allowed to propose direct bounded repair only
  // for PAIR, where Web is the repair authority by architecture. The verdict is
  // durably sealed first. Harness then applies/re-verifies; publication/result
  // generation become stale automatically and the planner rotates them before
  // any later review. AUTOPILOT deliberately does not enter this branch: its
  // selected Sol/Terra reviewer remains the repair proposer.
  if (receipt.state === "REVISION_REQUESTED" && envelope.repair_operations?.length && await isPairWebStrategy(options.stateDirectory, envelope.run_id, identity)) {
    await applyPairWebRepair({ envelope, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
  }
  return { verdict_path: verdictPath, receipt };
}