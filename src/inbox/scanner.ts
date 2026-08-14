import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { isGitBoundaryError } from "../git/contracts.js";
import { ensurePhaseStateDirectory, PreparationError, prepareTask } from "../run/preparation-service.js";
import { assertInboxDirectory, CandidatePolicyError, isCandidateFilename } from "./candidate-policy.js";
import type { InboxIndexEntry, ScanCandidateResult, ScanSummary, ScannerOptions, StabilityObservation } from "./contracts.js";
import { readInboxIndex, writeInboxIndex } from "./inbox-index.js";
import { StabilityTracker } from "./stability-tracker.js";

const MAXIMUM_STABILITY_STAT_CONCURRENCY = 32;

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function classify(code: string): ScanCandidateResult["result"] {
  const operationalCodes = new Set([
    "OPERATIONAL_ERROR", "CONFIG_NOT_FOUND", "CONFIG_NOT_REGULAR_FILE", "CONFIG_SYMLINK", "CONFIG_INVALID",
    "REPOSITORY_PATH_UNSAFE", "REPOSITORY_NOT_GIT", "REPOSITORY_BARE", "REMOTE_NOT_FOUND", "REMOTE_URL_MISMATCH",
    "FETCH_FAILED", "BASE_COMMIT_NOT_FOUND", "BASE_COMMIT_NOT_ANCESTOR", "BRANCH_ALREADY_EXISTS", "WORKTREE_ALREADY_EXISTS",
    "WORKTREE_CREATE_FAILED", "WORKTREE_VERIFY_FAILED", "RUN_RECEIPT_INCONSISTENT", "RUN_LOCKED",
  ]);
  if (operationalCodes.has(code)) return "failed";
  if (code.startsWith("ZIP_") || code.startsWith("BUNDLE_") || code.startsWith("CHECKSUM_") || code.startsWith("PAYLOAD_") || code === "EXECUTION_CONTRACT_REQUIRED") return "rejected";
  return "blocked";
}

interface CandidateObservationState {
  name: string;
  candidatePath: string;
  canonical: string;
  size: number;
  mtimeMs: number;
  observation: StabilityObservation;
  invalidated: boolean;
}

async function refreshCandidateBatch(
  batch: CandidateObservationState[],
  tracker: StabilityTracker,
  now: () => Date,
): Promise<void> {
  await Promise.all(batch.map(async (candidate) => {
    const latest = await lstat(candidate.candidatePath).catch(() => undefined);
    if (!latest || latest.isSymbolicLink() || !latest.isFile()) {
      candidate.invalidated = true;
      tracker.forget(candidate.canonical);
      return;
    }
    candidate.size = latest.size;
    candidate.mtimeMs = latest.mtimeMs;
    candidate.observation = tracker.observe(candidate.canonical, latest.size, latest.mtimeMs, now().getTime());
  }));
}

/**
 * Observe all candidate files in shared bounded rounds. Waiting once per round
 * keeps scan latency O(observation rounds) rather than O(candidates × rounds),
 * while chunked metadata reads prevent an oversized inbox from creating an
 * unbounded filesystem fan-out.
 */
async function stabilizeCandidates(
  candidates: CandidateObservationState[],
  tracker: StabilityTracker,
  requiredObservations: number,
  pollIntervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => Date,
): Promise<void> {
  const maximumAdditionalRounds = Math.max(0, requiredObservations - 1);
  for (let round = 0; round < maximumAdditionalRounds; round += 1) {
    const pending = candidates.filter((candidate) => !candidate.invalidated && candidate.observation.observations < requiredObservations);
    if (pending.length === 0) break;
    await sleep(pollIntervalMs);
    for (let offset = 0; offset < pending.length; offset += MAXIMUM_STABILITY_STAT_CONCURRENCY) {
      await refreshCandidateBatch(pending.slice(offset, offset + MAXIMUM_STABILITY_STAT_CONCURRENCY), tracker, now);
    }
  }
}

export async function scanInbox(options: ScannerOptions): Promise<ScanSummary> {
  await ensurePhaseStateDirectory(path.resolve(options.stateDirectory));
  const inbox = await assertInboxDirectory(options.inboxDirectory);
  const config = options.config ?? (await loadTrustedConfig(options.configPath)).inbox;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? delay;
  const tracker = new StabilityTracker(options.stability);
  const entries = await readdir(inbox, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && isCandidateFilename(entry.name)).map((entry) => entry.name).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (names.length > config.maximum_candidates_per_scan) throw new CandidatePolicyError("INBOX_LIMIT_EXCEEDED", `Inbox has more than ${config.maximum_candidates_per_scan} candidates.`);
  const index = await readInboxIndex(options.stateDirectory);
  const resultByName = new Map<string, ScanCandidateResult>();
  const candidates: CandidateObservationState[] = [];
  const presentCanonicalPaths = new Set<string>();
  let skipped = 0;

  // First observation is cheap and sequential so result ordering and index
  // handling remain deterministic. Heavy preparation is still performed only
  // after the shared stability rounds below.
  for (const name of names) {
    const candidatePath = path.join(inbox, name);
    const info = await lstat(candidatePath);
    if (info.isSymbolicLink() || !info.isFile()) continue;
    const canonical = await realpath(candidatePath);
    presentCanonicalPaths.add(canonical);
    const existing = index.entries[canonical];
    if (existing && existing.size === info.size && existing.mtime_ms === info.mtimeMs && (existing.latest_result === "ready_for_codex" || existing.latest_result === "rejected")) {
      skipped += 1;
      const skippedResult: ScanCandidateResult = { path: canonical, result: "skipped" };
      if (existing.archive_sha256 !== undefined) skippedResult.archive_sha256 = existing.archive_sha256;
      if (existing.latest_run_id !== undefined) skippedResult.run_id = existing.latest_run_id;
      resultByName.set(name, skippedResult);
      continue;
    }
    candidates.push({
      name,
      candidatePath,
      canonical,
      size: info.size,
      mtimeMs: info.mtimeMs,
      observation: tracker.observe(canonical, info.size, info.mtimeMs, now().getTime()),
      invalidated: false,
    });
  }

  // The index is a skip cache for files that are currently in the inbox, not a
  // historical ledger. Removing stale paths keeps persistent state bounded by
  // maximum_candidates_per_scan while preserving all active skip semantics.
  for (const canonical of Object.keys(index.entries)) {
    if (!presentCanonicalPaths.has(canonical)) delete index.entries[canonical];
  }

  await stabilizeCandidates(candidates, tracker, config.stable_observations, config.poll_interval_ms, sleep, now);

  let unstable = 0;
  for (const candidate of candidates) {
    if (candidate.invalidated) continue;
    const age = now().getTime() - candidate.mtimeMs;
    if (candidate.observation.observations < config.stable_observations || age < config.stable_age_ms) {
      unstable += 1;
      resultByName.set(candidate.name, { path: candidate.canonical, result: "unstable" });
      continue;
    }

    let result: ScanCandidateResult;
    try {
      const receipt = await prepareTask({ archivePath: candidate.canonical, stateDirectory: options.stateDirectory, configPath: options.configPath, now });
      result = { path: candidate.canonical, result: "ready_for_codex", archive_sha256: receipt.archive_sha256, run_id: receipt.run_id };
    } catch (error) {
      const code = error instanceof PreparationError ? error.code : isGitBoundaryError(error) ? error.code : "OPERATIONAL_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      const sourceReceipt = error instanceof PreparationError ? error.receipt : undefined;
      const archiveSha = sourceReceipt && "archive_sha256" in sourceReceipt ? sourceReceipt.archive_sha256 : undefined;
      const runId = sourceReceipt && "run_id" in sourceReceipt ? sourceReceipt.run_id : undefined;
      result = { path: candidate.canonical, result: classify(code), error: { code, message } };
      if (archiveSha !== undefined) result.archive_sha256 = archiveSha;
      if (runId !== undefined) result.run_id = runId;
    }
    const entry: InboxIndexEntry = { canonical_source_path: candidate.canonical, size: candidate.size, mtime_ms: candidate.mtimeMs, latest_result: result.result === "ready_for_codex" ? "ready_for_codex" : result.result === "rejected" ? "rejected" : result.result === "blocked" ? "blocked" : "failed", last_processed_time: now().toISOString() };
    if (result.archive_sha256) entry.archive_sha256 = result.archive_sha256;
    if (result.run_id) entry.latest_run_id = result.run_id;
    index.entries[candidate.canonical] = entry;
    resultByName.set(candidate.name, result);
  }

  const results = names.flatMap((name) => {
    const result = resultByName.get(name);
    return result ? [result] : [];
  });
  await writeInboxIndex(options.stateDirectory, index);
  return {
    scan_version: "1.0",
    discovered: names.length,
    unstable,
    skipped,
    ready_for_codex: results.filter((item) => item.result === "ready_for_codex").length,
    rejected: results.filter((item) => item.result === "rejected").length,
    blocked: results.filter((item) => item.result === "blocked").length,
    failed: results.filter((item) => item.result === "failed").length,
    results,
  };
}

export const scan = scanInbox;
