import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { isGitBoundaryError } from "../git/contracts.js";
import { ensurePhaseStateDirectory, PreparationError, prepareTask } from "../run/preparation-service.js";
import { assertInboxDirectory, CandidatePolicyError, isCandidateFilename } from "./candidate-policy.js";
import type { InboxIndexEntry, ScanCandidateResult, ScanSummary, ScannerOptions } from "./contracts.js";
import { readInboxIndex, writeInboxIndex } from "./inbox-index.js";
import { StabilityTracker } from "./stability-tracker.js";

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
  const results: ScanCandidateResult[] = [];
  let unstable = 0;
  let skipped = 0;
  for (const name of names) {
    const candidatePath = path.join(inbox, name);
    const info = await lstat(candidatePath);
    if (info.isSymbolicLink() || !info.isFile()) continue;
    const canonical = await realpath(candidatePath);
    const existing = index.entries[canonical];
    if (existing && existing.size === info.size && existing.mtime_ms === info.mtimeMs && (existing.latest_result === "ready_for_codex" || existing.latest_result === "rejected")) {
      skipped += 1;
      const skippedResult: ScanCandidateResult = { path: canonical, result: "skipped" };
      if (existing.archive_sha256 !== undefined) skippedResult.archive_sha256 = existing.archive_sha256;
      if (existing.latest_run_id !== undefined) skippedResult.run_id = existing.latest_run_id;
      results.push(skippedResult);
      continue;
    }
    let latestSize = info.size;
    let latestMtimeMs = info.mtimeMs;
    let observation = tracker.observe(canonical, latestSize, latestMtimeMs, now().getTime());
    while (observation.observations < config.stable_observations) {
      await sleep(config.poll_interval_ms);
      const latest = await lstat(candidatePath).catch(() => undefined);
      if (!latest || latest.isSymbolicLink() || !latest.isFile()) { tracker.forget(canonical); break; }
      latestSize = latest.size;
      latestMtimeMs = latest.mtimeMs;
      observation = tracker.observe(canonical, latestSize, latestMtimeMs, now().getTime());
    }
    const age = now().getTime() - latestMtimeMs;
    if (observation.observations < config.stable_observations || age < config.stable_age_ms) {
      unstable += 1;
      results.push({ path: canonical, result: "unstable" });
      continue;
    }
    let result: ScanCandidateResult;
    try {
      const receipt = await prepareTask({ archivePath: canonical, stateDirectory: options.stateDirectory, configPath: options.configPath, now });
      result = { path: canonical, result: "ready_for_codex", archive_sha256: receipt.archive_sha256, run_id: receipt.run_id };
    } catch (error) {
      const code = error instanceof PreparationError ? error.code : isGitBoundaryError(error) ? error.code : "OPERATIONAL_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      const sourceReceipt = error instanceof PreparationError ? error.receipt : undefined;
      const archiveSha = sourceReceipt && "archive_sha256" in sourceReceipt ? sourceReceipt.archive_sha256 : undefined;
      const runId = sourceReceipt && "run_id" in sourceReceipt ? sourceReceipt.run_id : undefined;
      result = { path: canonical, result: classify(code), error: { code, message } };
      if (archiveSha !== undefined) result.archive_sha256 = archiveSha;
      if (runId !== undefined) result.run_id = runId;
    }
    const entry: InboxIndexEntry = { canonical_source_path: canonical, size: latestSize, mtime_ms: latestMtimeMs, latest_result: result.result === "ready_for_codex" ? "ready_for_codex" : result.result === "rejected" ? "rejected" : result.result === "blocked" ? "blocked" : "failed", last_processed_time: now().toISOString() };
    if (result.archive_sha256) entry.archive_sha256 = result.archive_sha256;
    if (result.run_id) entry.latest_run_id = result.run_id;
    index.entries[canonical] = entry;
    results.push(result);
  }
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
