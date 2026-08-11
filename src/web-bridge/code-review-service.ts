import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../run/run-store.js";
import { loadAndVerifyResultBundle } from "../web-review/result-bundle-review-reader.js";
import { contentDigest, parseWebVerdictEnvelope, WebBridgeError, type BridgeJobIdentity, type WebVerdictEnvelope } from "./contracts.js";
import { readBoundedResultEvidence } from "./result-evidence-reader.js";
import type { WebBridge } from "./web-bridge.js";

export type WebCodeReviewState = "PENDING" | "APPROVED" | "REVISION_REQUESTED" | "ESCALATED";

export interface WebCodeReviewReceipt {
  schema_version: "1.0";
  kind: "wco-web-code-review";
  run_id: string;
  review_round: number;
  review_job_id: string;
  result_bundle_sha256: string;
  published_commit_sha: string;
  pull_request_number: number;
  state: WebCodeReviewState;
  verdict_sha256: string | null;
  summary: string | null;
  findings: Array<{ id: string; severity: "blocking" | "non_blocking"; description: string }>;
  created_at: string;
  updated_at: string;
}

const MAX_RECEIPT_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; archiveSha: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const archiveSha = runId.slice(split + 1);
  if (split < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !SHA256.test(archiveSha)) throw new WebBridgeError("WEB_CODE_REVIEW_RUN_INVALID", "Run identity is invalid.");
  return { taskId, archiveSha };
}

function receiptPath(stateDirectory: string, runId: string): string {
  const id = splitRunId(runId);
  return path.join(path.resolve(stateDirectory), "bridge", "code-reviews", id.taskId, id.archiveSha, "receipt.json");
}

function validateReceipt(value: unknown, runId: string): WebCodeReviewReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt must be an object.");
  const receipt = value as Partial<WebCodeReviewReceipt>;
  if (
    receipt.schema_version !== "1.0" || receipt.kind !== "wco-web-code-review" || receipt.run_id !== runId ||
    !Number.isInteger(receipt.review_round) || (receipt.review_round as number) < 1 || (receipt.review_round as number) > 4 ||
    typeof receipt.review_job_id !== "string" || receipt.review_job_id.length < 1 || receipt.review_job_id.length > 128 ||
    typeof receipt.result_bundle_sha256 !== "string" || !SHA256.test(receipt.result_bundle_sha256) ||
    typeof receipt.published_commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.published_commit_sha) ||
    !Number.isInteger(receipt.pull_request_number) || (receipt.pull_request_number as number) < 1 ||
    !["PENDING", "APPROVED", "REVISION_REQUESTED", "ESCALATED"].includes(String(receipt.state)) ||
    !(receipt.verdict_sha256 === null || typeof receipt.verdict_sha256 === "string" && SHA256.test(receipt.verdict_sha256)) ||
    !(receipt.summary === null || typeof receipt.summary === "string" && receipt.summary.length <= 16_384) ||
    !Array.isArray(receipt.findings) || receipt.findings.length > 256 ||
    !receipt.findings.every((finding) => finding && typeof finding === "object" && typeof finding.id === "string" && finding.id.length <= 128 && ["blocking", "non_blocking"].includes(finding.severity) && typeof finding.description === "string" && finding.description.length <= 8_192) ||
    typeof receipt.created_at !== "string" || !Number.isFinite(Date.parse(receipt.created_at)) ||
    typeof receipt.updated_at !== "string" || !Number.isFinite(Date.parse(receipt.updated_at))
  ) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt is malformed.");
  if (receipt.state === "PENDING" && (receipt.verdict_sha256 !== null || receipt.summary !== null || receipt.findings.length !== 0)) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Pending code-review receipt contains terminal verdict data.");
  if (receipt.state !== "PENDING" && (receipt.verdict_sha256 === null || receipt.summary === null)) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Terminal code-review receipt lacks immutable verdict data.");
  return receipt as WebCodeReviewReceipt;
}

export async function readWebCodeReviewReceipt(stateDirectory: string, runId: string): Promise<WebCodeReviewReceipt | null> {
  const target = receiptPath(stateDirectory, runId);
  try {
    const bytes = await readFile(target);
    if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt exceeds byte cap.");
    return validateReceipt(JSON.parse(bytes.toString("utf8")) as unknown, runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof WebBridgeError) throw error;
    throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", `Code-review receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function currentResult(stateDirectory: string, runId: string, reviewRound: number) {
  const bundle = await loadAndVerifyResultBundle(stateDirectory, runId, reviewRound);
  if (!bundle.receipt.archive_sha256 || !bundle.receipt.published_commit_sha || bundle.receipt.pull_request.number < 1) throw new WebBridgeError("WEB_CODE_REVIEW_RESULT_INVALID", "Exact Result Bundle lacks required code-review bindings.");
  return bundle;
}

function currentReviewRound(receipt: { result_bundle_version: string; revision_round?: number | null }): number {
  return receipt.result_bundle_version === "1.2" ? (receipt.revision_round ?? 1) + 1 : 1;
}

export async function createPendingCodeReview(options: { bridge: WebBridge; runId: string; stateDirectory: string; now?: () => Date }): Promise<BridgeJobIdentity> {
  const existing = await readWebCodeReviewReceipt(options.stateDirectory, options.runId);
  if (existing?.state === "PENDING") {
    const bundle = await currentResult(options.stateDirectory, options.runId, existing.review_round);
    if (bundle.receipt.archive_sha256 !== existing.result_bundle_sha256 || bundle.receipt.published_commit_sha !== existing.published_commit_sha || bundle.receipt.pull_request.number !== existing.pull_request_number) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "Pending code review no longer binds the current exact Result Bundle.");
  }
  if (existing?.state === "APPROVED") throw new WebBridgeError("WEB_CODE_REVIEW_ALREADY_APPROVED", "The current exact result already has an approved independent Web code review.");

  const seedBundle = existing
    ? await currentResult(options.stateDirectory, options.runId, existing.review_round)
    : await currentResult(options.stateDirectory, options.runId, 1).catch(async () => {
        for (let round = 4; round >= 2; round -= 1) {
          try { return await currentResult(options.stateDirectory, options.runId, round); } catch { /* keep scanning newest valid revision */ }
        }
        throw new WebBridgeError("WEB_CODE_REVIEW_RESULT_INVALID", "No exact Result Bundle is available for code review.");
      });
  const reviewRound = currentReviewRound(seedBundle.receipt);
  const bundle = reviewRound === seedBundle.reviewRound ? seedBundle : await currentResult(options.stateDirectory, options.runId, reviewRound);
  const request = {
    run_id: options.runId,
    result_bundle_sha256: bundle.receipt.archive_sha256!,
    published_commit_sha: bundle.receipt.published_commit_sha,
    pull_request_url: bundle.receipt.pull_request.url,
    review_round: reviewRound,
  };
  const identity = await options.bridge.createFinalReviewJob(request, `code-review-${contentDigest({ purpose: "independent_code_review", request })}`);
  const evidence = await readBoundedResultEvidence(bundle.archivePath, bundle.manifest);
  await options.bridge.submitFinalReviewEvidence(identity.job_id, { purpose: "independent_code_review", binding: request, entries: evidence }, `code-evidence-${bundle.receipt.archive_sha256}`);

  const now = (options.now?.() ?? new Date()).toISOString();
  const receipt: WebCodeReviewReceipt = {
    schema_version: "1.0",
    kind: "wco-web-code-review",
    run_id: options.runId,
    review_round: reviewRound,
    review_job_id: identity.job_id,
    result_bundle_sha256: bundle.receipt.archive_sha256!,
    published_commit_sha: bundle.receipt.published_commit_sha,
    pull_request_number: bundle.receipt.pull_request.number,
    state: "PENDING",
    verdict_sha256: null,
    summary: null,
    findings: [],
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await mkdir(path.dirname(receiptPath(options.stateDirectory, options.runId)), { recursive: true, mode: 0o700 });
  await atomicWriteJson(receiptPath(options.stateDirectory, options.runId), receipt);
  return identity;
}

export async function adoptCodeReviewVerdict(options: { envelope: WebVerdictEnvelope | unknown; stateDirectory: string; now?: () => Date }): Promise<WebCodeReviewReceipt> {
  const envelope = parseWebVerdictEnvelope(options.envelope);
  const receipt = await readWebCodeReviewReceipt(options.stateDirectory, envelope.run_id);
  if (!receipt) throw new WebBridgeError("WEB_CODE_REVIEW_NOT_PENDING", "No durable independent Web code-review job exists for this run.");
  if (receipt.state !== "PENDING") {
    const digest = contentDigest(envelope);
    if (receipt.verdict_sha256 === digest) return receipt;
    throw new WebBridgeError("WEB_CODE_REVIEW_ALREADY_SEALED", "Independent Web code review is already sealed with a different verdict.");
  }
  if (envelope.review_id !== receipt.review_job_id || envelope.result_bundle_sha256 !== receipt.result_bundle_sha256) throw new WebBridgeError("WEB_CODE_REVIEW_BINDING_MISMATCH", "Web code-review verdict does not bind the pending review job and exact Result Bundle.");
  const bundle = await currentResult(options.stateDirectory, envelope.run_id, receipt.review_round);
  if (bundle.receipt.archive_sha256 !== receipt.result_bundle_sha256 || bundle.receipt.published_commit_sha !== receipt.published_commit_sha || bundle.receipt.pull_request.number !== receipt.pull_request_number) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "Web code-review verdict is stale relative to the exact current Result Bundle.");

  const blocking = envelope.findings.filter((finding) => finding.severity === "blocking");
  if (envelope.verdict === "APPROVE" && blocking.length > 0) throw new WebBridgeError("WEB_CODE_REVIEW_POLICY_INVALID", "APPROVE cannot contain blocking code-review findings.");
  if (envelope.verdict === "REVISE" && blocking.length === 0) throw new WebBridgeError("WEB_CODE_REVIEW_POLICY_INVALID", "REVISE requires at least one blocking code-review finding.");
  const state: WebCodeReviewState = envelope.verdict === "APPROVE" ? "APPROVED" : envelope.verdict === "REVISE" ? "REVISION_REQUESTED" : "ESCALATED";
  const terminal: WebCodeReviewReceipt = {
    ...receipt,
    state,
    verdict_sha256: contentDigest(envelope),
    summary: envelope.summary,
    findings: envelope.findings,
    updated_at: (options.now?.() ?? new Date()).toISOString(),
  };
  validateReceipt(terminal, envelope.run_id);
  await atomicWriteJson(receiptPath(options.stateDirectory, envelope.run_id), terminal);
  return terminal;
}

export async function assertCodeReviewApprovedForCurrentResult(stateDirectory: string, runId: string): Promise<WebCodeReviewReceipt> {
  const receipt = await readWebCodeReviewReceipt(stateDirectory, runId);
  if (!receipt || receipt.state !== "APPROVED") throw new WebBridgeError("WEB_CODE_REVIEW_REQUIRED", "Independent Web code review has not approved the exact result.");
  const bundle = await currentResult(stateDirectory, runId, receipt.review_round);
  if (bundle.receipt.archive_sha256 !== receipt.result_bundle_sha256 || bundle.receipt.published_commit_sha !== receipt.published_commit_sha || bundle.receipt.pull_request.number !== receipt.pull_request_number) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "Approved Web code review no longer binds the exact current Result Bundle.");
  return receipt;
}
