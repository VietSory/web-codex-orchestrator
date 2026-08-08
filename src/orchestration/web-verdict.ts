import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readAndCanonicalizeVerdict } from "../web-review/verdict-source-reader.js";
import { submitWebVerdict } from "../web-review/web-review-service.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { OrchestrationError } from "./contracts.js";
import { orchestrationPaths } from "./paths.js";
import { sealTransitionRequest } from "./retry-policy.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) {
    throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for Web verdict orchestration.");
  }
  return { taskId, taskBundleSha256 };
}

async function assertCanonicalDirectory(directory: string, root: string): Promise<void> {
  const resolved = path.resolve(directory);
  const resolvedRoot = path.resolve(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new OrchestrationError("ORCHESTRATION_VERDICT_STATE_UNSAFE", "Web verdict staging directory escapes orchestration state.");
  }
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(resolved)) !== resolved) {
    throw new OrchestrationError("ORCHESTRATION_VERDICT_STATE_UNSAFE", "Web verdict staging directory must be a canonical real directory.");
  }
}

function stagedVerdictPath(stateDirectory: string, runId: string, reviewRound: number): string {
  const id = splitRunId(runId);
  const runPaths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256);
  return path.join(runPaths.directory, "inputs", `web-verdict-round-${String(reviewRound).padStart(2, "0")}.json`);
}

export interface PreparedWebVerdict {
  verdictPath: string;
  verdictSha256: string;
  reviewRound: number;
}

export async function prepareWebVerdictForRun(options: {
  runId: string;
  stateDirectory: string;
  verdictPath: string;
  expectedRequestSha256?: string;
}): Promise<PreparedWebVerdict> {
  const ingested = await readAndCanonicalizeVerdict(options.verdictPath);
  const raw = ingested.parsedVerdict as { review_round?: unknown } | null;
  const reviewRound = raw?.review_round;
  if (!Number.isInteger(reviewRound) || (reviewRound as number) < 1 || (reviewRound as number) > 4) {
    throw new OrchestrationError("ORCHESTRATION_VERDICT_INVALID", "Web verdict review_round must be an integer from 1 through 4.");
  }
  const sealedRequest = sealTransitionRequest("WAIT_WEB_VERDICT", {
    verdict_sha256: ingested.verdictSha256,
    review_round: reviewRound as number,
  });
  if (options.expectedRequestSha256 && sealedRequest !== options.expectedRequestSha256) {
    throw new OrchestrationError("ORCHESTRATION_ATTEMPT_CONFLICT", "Supplied Web verdict differs from the already-sealed transition attempt.");
  }

  const id = splitRunId(options.runId);
  const runPaths = orchestrationPaths(options.stateDirectory, id.taskId, id.taskBundleSha256);
  await fs.mkdir(runPaths.directory, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(runPaths.directory, runPaths.root);

  const inputsDirectory = path.join(runPaths.directory, "inputs");
  await fs.mkdir(inputsDirectory, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(inputsDirectory, runPaths.directory);

  const target = stagedVerdictPath(options.stateDirectory, options.runId, reviewRound as number);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, ingested.canonicalBuffer, { flag: "wx", mode: 0o600 });
    try {
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new OrchestrationError("ORCHESTRATION_VERDICT_STATE_UNSAFE", "Existing staged Web verdict path is unsafe.");
      }
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }

  const staged = await readAndCanonicalizeVerdict(target);
  if (staged.verdictSha256 !== ingested.verdictSha256) {
    throw new OrchestrationError("ORCHESTRATION_VERDICT_DRIFT", "Staged Web verdict digest differs from the accepted input digest.");
  }
  return { verdictPath: target, verdictSha256: staged.verdictSha256, reviewRound: reviewRound as number };
}

export async function recoverPreparedWebVerdictForAttempt(options: {
  runId: string;
  stateDirectory: string;
  requestSha256: string;
}): Promise<PreparedWebVerdict | null> {
  for (let reviewRound = 1; reviewRound <= 4; reviewRound += 1) {
    const verdictPath = stagedVerdictPath(options.stateDirectory, options.runId, reviewRound);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(verdictPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new OrchestrationError("ORCHESTRATION_VERDICT_STATE_UNSAFE", "Staged Web verdict path is unsafe during recovery.");
    }
    const staged = await readAndCanonicalizeVerdict(verdictPath);
    const sealed = sealTransitionRequest("WAIT_WEB_VERDICT", {
      verdict_sha256: staged.verdictSha256,
      review_round: reviewRound,
    });
    if (sealed === options.requestSha256) {
      return { verdictPath, verdictSha256: staged.verdictSha256, reviewRound };
    }
  }
  return null;
}

export async function submitPreparedWebVerdict(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  prepared: PreparedWebVerdict;
  now?: () => Date;
}): Promise<WebReviewReceipt> {
  const receipt = await submitWebVerdict({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    verdictPath: options.prepared.verdictPath,
    ...(options.now ? { now: options.now } : {}),
  });
  if (
    receipt.run_id !== options.runId ||
    receipt.review_round !== options.prepared.reviewRound ||
    receipt.verdict_sha256 !== options.prepared.verdictSha256
  ) {
    throw new OrchestrationError("ORCHESTRATION_VERDICT_DRIFT", "Web review receipt does not bind the exact staged verdict.");
  }
  return receipt;
}
