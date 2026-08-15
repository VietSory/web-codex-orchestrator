import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../run/run-store.js";
import { loadAndVerifyResultBundle, type LoadedResultBundle } from "../web-review/result-bundle-review-reader.js";
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

function reviewDirectory(stateDirectory: string, runId: string): string {
  const id = splitRunId(runId);
  return path.join(path.resolve(stateDirectory), "bridge", "code-reviews", id.taskId, id.archiveSha);
}

function receiptPath(stateDirectory: string, runId: string): string {
  return path.join(reviewDirectory(stateDirectory, runId), "receipt.json");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertStateRoot(stateDirectory: string): Promise<string> {
  const root = path.resolve(stateDirectory);
  let info: Stats;
  try { info = await fs.lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "WCO state directory does not exist.");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== root) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "WCO state directory is not a canonical real directory.");
  return root;
}

async function ensureReviewDirectory(stateDirectory: string, runId: string): Promise<string> {
  const root = await assertStateRoot(stateDirectory);
  const target = reviewDirectory(root, runId);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state path escapes the WCO state directory.");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info: Stats;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      info = await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state ancestry contains a symlink or non-directory.");
  }
  if (await fs.realpath(target) !== target) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state directory is not canonical.");
  return target;
}

async function existingReviewDirectory(stateDirectory: string, runId: string): Promise<string | null> {
  const root = await assertStateRoot(stateDirectory);
  const target = reviewDirectory(root, runId);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info: Stats;
    try { info = await fs.lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state ancestry contains a symlink or non-directory.");
  }
  if (await fs.realpath(target) !== target) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state directory is not canonical.");
  return target;
}

async function readStableReceipt(stateDirectory: string, runId: string): Promise<Buffer | null> {
  const directory = await existingReviewDirectory(stateDirectory, runId);
  if (!directory) return null;
  const target = path.join(directory, "receipt.json");
  let pathInfo: Stats;
  try { pathInfo = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > MAX_RECEIPT_BYTES) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt is unsafe or exceeds its byte cap.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", `Code-review receipt cannot be opened safely: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(before, pathInfo) || before.size !== pathInfo.size || before.size > MAX_RECEIPT_BYTES) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt changed before stable open.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt grew while reading.");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), fs.lstat(target)]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameFile(before, afterHandle) || !sameFile(before, afterPath) || afterHandle.size !== before.size || afterPath.size !== before.size) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review receipt changed while reading.");
    if (await fs.realpath(directory) !== directory) throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", "Code-review state ancestry changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
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
  try {
    const bytes = await readStableReceipt(stateDirectory, runId);
    if (!bytes) return null;
    return validateReceipt(JSON.parse(bytes.toString("utf8")) as unknown, runId);
  } catch (error) {
    if (error instanceof WebBridgeError) throw error;
    throw new WebBridgeError("WEB_CODE_REVIEW_STATE_INVALID", `Code-review receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exactResult(stateDirectory: string, runId: string, reviewRound: number): Promise<LoadedResultBundle> {
  const bundle = await loadAndVerifyResultBundle(stateDirectory, runId, reviewRound);
  if (!bundle.receipt.archive_sha256 || !bundle.receipt.published_commit_sha || bundle.receipt.pull_request.number < 1) throw new WebBridgeError("WEB_CODE_REVIEW_RESULT_INVALID", "Exact Result Bundle lacks required code-review bindings.");
  return bundle;
}

async function newestExactResult(stateDirectory: string, runId: string): Promise<LoadedResultBundle> {
  let lastError: unknown;
  for (let round = 4; round >= 1; round -= 1) {
    try { return await exactResult(stateDirectory, runId, round); }
    catch (error) { lastError = error; }
  }
  throw new WebBridgeError("WEB_CODE_REVIEW_RESULT_INVALID", `No exact Result Bundle is available for code review${lastError instanceof Error ? `: ${lastError.message}` : "."}`);
}

function sameResult(receipt: WebCodeReviewReceipt, bundle: LoadedResultBundle): boolean {
  return receipt.review_round === bundle.reviewRound
    && receipt.result_bundle_sha256 === bundle.receipt.archive_sha256
    && receipt.published_commit_sha === bundle.receipt.published_commit_sha
    && receipt.pull_request_number === bundle.receipt.pull_request.number;
}

export async function createPendingCodeReview(options: { bridge: WebBridge; runId: string; stateDirectory: string; now?: () => Date }): Promise<BridgeJobIdentity> {
  const [existing, newest] = await Promise.all([
    readWebCodeReviewReceipt(options.stateDirectory, options.runId),
    newestExactResult(options.stateDirectory, options.runId),
  ]);
  if (existing?.state === "PENDING" && !sameResult(existing, newest)) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "A pending code review cannot be silently retargeted after the exact Result Bundle changed.");
  if (existing?.state === "APPROVED" && sameResult(existing, newest)) throw new WebBridgeError("WEB_CODE_REVIEW_ALREADY_APPROVED", "The current exact result already has an approved independent Web code review.");

  const request = {
    run_id: options.runId,
    result_bundle_sha256: newest.receipt.archive_sha256!,
    published_commit_sha: newest.receipt.published_commit_sha,
    pull_request_url: newest.receipt.pull_request.url,
    review_round: newest.reviewRound,
  };
  const identity = await options.bridge.createFinalReviewJob(request, `code-review-${contentDigest({ purpose: "independent_code_review", request })}`);
  if (existing?.state === "PENDING" && identity.job_id !== existing.review_job_id) throw new WebBridgeError("WEB_CODE_REVIEW_REPLAY_CONFLICT", "Relay idempotency returned a different code-review job identity.");
  const evidence = await readBoundedResultEvidence(newest.archivePath, newest.manifest);
  await options.bridge.submitFinalReviewEvidence(identity.job_id, { purpose: "independent_code_review", binding: request, entries: evidence }, `code-evidence-${newest.receipt.archive_sha256}`);

  const now = (options.now?.() ?? new Date()).toISOString();
  const receipt: WebCodeReviewReceipt = existing?.state === "PENDING" ? existing : {
    schema_version: "1.0",
    kind: "wco-web-code-review",
    run_id: options.runId,
    review_round: newest.reviewRound,
    review_job_id: identity.job_id,
    result_bundle_sha256: newest.receipt.archive_sha256!,
    published_commit_sha: newest.receipt.published_commit_sha,
    pull_request_number: newest.receipt.pull_request.number,
    state: "PENDING",
    verdict_sha256: null,
    summary: null,
    findings: [],
    created_at: now,
    updated_at: now,
  };
  await ensureReviewDirectory(options.stateDirectory, options.runId);
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
  const newest = await newestExactResult(options.stateDirectory, envelope.run_id);
  if (!sameResult(receipt, newest)) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "Web code-review verdict is stale relative to the newest exact Result Bundle.");

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
  await ensureReviewDirectory(options.stateDirectory, envelope.run_id);
  await atomicWriteJson(receiptPath(options.stateDirectory, envelope.run_id), terminal);
  return terminal;
}

export async function assertCodeReviewApprovedForCurrentResult(stateDirectory: string, runId: string): Promise<WebCodeReviewReceipt> {
  const [receipt, newest] = await Promise.all([
    readWebCodeReviewReceipt(stateDirectory, runId),
    newestExactResult(stateDirectory, runId),
  ]);
  if (!receipt || receipt.state !== "APPROVED") throw new WebBridgeError("WEB_CODE_REVIEW_REQUIRED", "Independent Web code review has not approved the exact result.");
  if (!sameResult(receipt, newest)) throw new WebBridgeError("WEB_CODE_REVIEW_STALE", "Approved Web code review no longer binds the newest exact Result Bundle.");
  return receipt;
}
