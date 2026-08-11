import crypto from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPhase4Config, readBundleJson } from "../execution/execution-config.js";
import { assertPhase4ExecutionContract } from "../execution/execution-validator.js";
import { GitRunner } from "../git/git-runner.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";
import { preparePublishGitSecurity, type PreparedPublishGitSecurity } from "../publish/publish-auth.js";
import { publishPreparedPhase4Run } from "../publish/phase4-publish-service.js";
import { readGitPublishReceiptSnapshot, writeGitPublishReceipt, type GitPublishReceiptSnapshot } from "../publish/publish-store.js";
import type { GitPublishReceipt } from "../publish/contracts.js";
import { calculateApprovedRevisionSnapshot, publishRevision } from "../revision/revision-git.js";
import { OrchestrationError } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";

function boundedCommitMessage(taskId: string, title: string, repair = false): string {
  const normalizedTitle = title.replace(/[\r\n\t\u0000]+/g, " ").trim();
  const normalizedTask = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const prefix = repair ? "Repair verified task" : "Apply verified task";
  return `${prefix} ${normalizedTask}${normalizedTitle ? `: ${normalizedTitle}` : ""}`.slice(0, 4_096);
}

async function verifyConfiguredIdentity(runner: GitRunner, worktreePath: string, expected: { name: string; email: string }): Promise<void> {
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] as const) {
    const result = await runner.run(["var", variable], worktreePath);
    if (result.exitCode !== 0) throw new OrchestrationError("ORCHESTRATION_PUBLISH_IDENTITY_INVALID", `Failed to verify ${variable}.`);
    const match = /^(.*)\s+<([^>]+)>\s+\d+\s+[+-]\d+$/.exec(result.stdout.trim());
    if (!match || match[1] !== expected.name || match[2] !== expected.email) throw new OrchestrationError("ORCHESTRATION_PUBLISH_IDENTITY_INVALID", `Git identity mismatch for ${variable}.`);
  }
}

async function cleanupPublishAuth(auth: PreparedPublishGitSecurity): Promise<void> {
  if (auth.mode !== "https_token") return;
  await unlink(auth.askpassScriptPath).catch(() => undefined);
}

async function archivePublishSnapshot(publishDirectory: string, snapshot: GitPublishReceiptSnapshot): Promise<void> {
  const digest = crypto.createHash("sha256").update(snapshot.bytes).digest("hex");
  const history = path.join(publishDirectory, "history");
  await mkdir(history, { recursive: true, mode: 0o700 });
  const target = path.join(history, `git-publish-${digest}.json`);
  try { await writeFile(target, snapshot.bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (!existing.equals(snapshot.bytes)) throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "Archived publish generation conflicts with the exact previous receipt bytes.");
  }
}

export async function publishReadyExecutorSnapshot(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<GitPublishReceipt> {
  const ready = await attestReadyExecutorSnapshot(options);
  const config = await loadPhase4Config(options.configPath);
  if (!config.publish) throw new OrchestrationError("ORCHESTRATION_PUBLISH_CONFIG_MISSING", "Trusted publish configuration is required before publication.");

  const acceptedBundlePath = ready.source.trusted.runReceipt.accepted_bundle_path;
  await verifyBundleChecksums(acceptedBundlePath);
  const bundle = await readBundleJson(acceptedBundlePath);
  const contract = assertPhase4ExecutionContract(bundle.manifest);
  const run = ready.source.trusted.runReceipt;
  if (
    contract.task_id !== run.task_id || contract.repository.id !== run.repository_id || contract.repository.base_branch !== run.base_branch || contract.repository.base_commit !== run.base_commit ||
    contract.delivery.remote !== run.remote || contract.delivery.branch_name !== run.branch_name || contract.delivery.base_branch !== run.base_branch || contract.delivery.draft !== true || contract.delivery.auto_merge !== false ||
    contract.git_policy.allowed_remote !== run.remote || contract.git_policy.allow_force_push !== false || contract.git_policy.allow_remote_branch_delete !== false || contract.git_policy.allow_merge !== false
  ) throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "Accepted Task Bundle delivery contract no longer matches the canonical run.");

  const publishDirectory = path.join(ready.executorDirectory, "publish");
  const publishPath = path.join(publishDirectory, "git-publish.json");
  const previousSnapshot = await readGitPublishReceiptSnapshot(publishPath);
  const runtimeDirectory = path.join(publishDirectory, "git-runtime");
  const auth = await preparePublishGitSecurity(config.publish, run.remote_url, runtimeDirectory, process.env);

  try {
    const runner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth, allowedRemoteUrl: run.remote_url });
    await verifyConfiguredIdentity(runner, run.worktree_path, config.publish.identity);
    const previous = previousSnapshot?.receipt ?? null;

    if (previous && previous.state === "PUSHED" && previous.change_set_sha256 !== ready.changeSetDigest) {
      const repair = ready.receipt.repair;
      if (!repair || repair.state !== "VERIFIED" || repair.source_change_set_digest !== previous.change_set_sha256 || repair.final_change_set_digest !== ready.changeSetDigest || previous.commit_sha === null || previous.remote_branch_sha !== previous.commit_sha) {
        throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "A changed executor digest may be republished only from one verified repair bound to the exact previous PUSHED generation.");
      }
      const repairPaths = [...new Set(repair.operations.map((operation) => operation.path))].sort();
      if (repairPaths.length === 0) throw new OrchestrationError("ORCHESTRATION_PUBLISH_AUTHORITY_DRIFT", "Verified repair has no paths to republish.");
      const revisionSnapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: run.worktree_path, approvedPaths: repairPaths });
      const fullSnapshot = await calculateApprovedRevisionSnapshot({ runner, worktreePath: run.worktree_path, approvedPaths: ready.changedPaths });
      if (previousSnapshot) await archivePublishSnapshot(publishDirectory, previousSnapshot);
      const revised = await publishRevision({
        worktreePath: run.worktree_path,
        branchName: run.branch_name,
        remoteName: run.remote,
        remoteUrl: run.remote_url,
        previousHeadSha: previous.commit_sha,
        initialRefsSha256: "",
        approvedPaths: repairPaths,
        approvedSnapshotSha256: revisionSnapshot,
        commitMessage: boundedCommitMessage(contract.task_id, contract.title, true),
      }, runner);
      const timestamp = (options.now?.() ?? new Date()).toISOString();
      const receipt: GitPublishReceipt = {
        publish_version: "1.1",
        run_id: run.run_id,
        state: "PUSHED",
        base_commit: run.base_commit,
        branch_name: run.branch_name,
        remote_name: run.remote,
        allowed_remote_url: run.remote_url,
        change_set_sha256: ready.changeSetDigest,
        expected_paths: [...ready.changedPaths].sort(),
        approved_snapshot_sha256: fullSnapshot,
        commit_sha: revised.new_commit_sha,
        remote_branch_sha: revised.remote_branch_sha,
        created_at: timestamp,
        updated_at: timestamp,
        committed_at: timestamp,
        pushed_at: timestamp,
      };
      await writeGitPublishReceipt(publishPath, receipt);
      return receipt;
    }

    return await publishPreparedPhase4Run({
      runId: run.run_id,
      taskId: run.task_id,
      archiveSha256: run.archive_sha256,
      stateDirectory: options.stateDirectory,
      executionDirectory: ready.executorDirectory,
      worktreePath: run.worktree_path,
      baseCommit: run.base_commit,
      branchName: run.branch_name,
      remoteName: run.remote,
      allowedRemoteUrl: run.remote_url,
      allowedBranchPrefix: contract.git_policy.allowed_branch_prefix,
      denyDirectPushBranches: [...contract.git_policy.deny_direct_push_branches],
      expectedChangeSetSha256: ready.changeSetDigest,
      expectedPaths: ready.changedPaths,
      commitMessage: boundedCommitMessage(contract.task_id, contract.title),
      runner,
      inspectVerifiedChangeSet: async () => { const current = await attestReadyExecutorSnapshot(options); return { change_set_sha256: current.changeSetDigest, paths: current.changedPaths }; },
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    await cleanupPublishAuth(auth);
  }
}
