import fs from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { loadSealedRevisionSource } from "../revision/revision-source.js";
import { reviseRun } from "../revision/revision-service.js";
import type { RevisionReceipt } from "../revision/contracts.js";
import { getWebReviewStatus } from "../web-review/web-review-service.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { OrchestrationError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export interface RevisionOrchestrationAuthority {
  revisionRound: number;
  revisionRequestSha256: string;
  verdictSha256: string;
  decisionEventSha256: string;
  publishedCommitSha: string;
  pullRequestNumber: number;
  freshAttestedHeadSha: string;
}

export function revisionOrchestrationPayload(authority: RevisionOrchestrationAuthority): Record<string, unknown> {
  return {
    review_round: authority.revisionRound,
    verdict_sha256: authority.verdictSha256,
    revision_request_sha256: authority.revisionRequestSha256,
    decision_event_sha256: authority.decisionEventSha256,
    published_commit_sha: authority.publishedCommitSha,
    pull_request_number: authority.pullRequestNumber,
  };
}

export function revisionOrchestrationUsage(receipt: RevisionReceipt): { model_turns: number; input_tokens: number; output_tokens: number } {
  return {
    model_turns: receipt.usage.total_turns,
    input_tokens: receipt.usage.input_tokens,
    output_tokens: receipt.usage.output_tokens,
  };
}

export function assertRevisionResultForOrchestration(
  runId: string,
  receipt: RevisionReceipt,
  authority: RevisionOrchestrationAuthority,
): void {
  if (
    receipt.run_id !== runId ||
    receipt.revision_round !== authority.revisionRound ||
    receipt.state !== "RESULT_READY" ||
    receipt.previous_verdict_sha256 !== authority.verdictSha256 ||
    receipt.revision_request_sha256 !== authority.revisionRequestSha256 ||
    receipt.previous_pr_head_sha !== authority.freshAttestedHeadSha ||
    receipt.pull_request_number !== authority.pullRequestNumber ||
    receipt.new_published_commit_sha === null ||
    receipt.remote_branch_sha !== receipt.new_published_commit_sha ||
    receipt.result_bundle_sha256 === null || !SHA256.test(receipt.result_bundle_sha256) ||
    receipt.result_manifest_sha256 === null || !SHA256.test(receipt.result_manifest_sha256) ||
    receipt.next_review_round !== authority.revisionRound + 1
  ) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_INCOMPLETE", "Revision did not produce an exact same-PR fast-forward Result Bundle bound to the sealed Web request.");
  }
}

export async function attestRevisionAuthorityForOrchestration(options: {
  runId: string;
  stateDirectory: string;
}): Promise<RevisionOrchestrationAuthority> {
  const review = await getWebReviewStatus({ runId: options.runId, stateDirectory: options.stateDirectory });
  if (!review || review.run_id !== options.runId || review.state !== "REVISION_REQUESTED") {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "No terminal REVISION_REQUESTED Web Review receipt authorizes a revision.");
  }
  if (!Number.isInteger(review.review_round) || review.review_round < 1 || review.review_round > 3) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Revision-requested review round is outside the supported 1..3 revision window.");
  }
  if (!review.revision_request_sha256 || !SHA256.test(review.revision_request_sha256) || !review.verdict_sha256 || !SHA256.test(review.verdict_sha256) || !review.decision_event_sha256 || !SHA256.test(review.decision_event_sha256)) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority is missing sealed SHA-256 bindings.");
  }
  if (!review.fresh_attested_head_sha || !GIT_SHA.test(review.fresh_attested_head_sha) || review.fresh_attested_head_sha !== review.published_commit_sha || !GIT_SHA.test(review.published_commit_sha)) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority is not bound to the freshly attested published head.");
  }
  if (!Number.isInteger(review.pull_request_number) || review.pull_request_number < 1) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority has an invalid pull request number.");
  }

  const source = await loadSealedRevisionSource(options.stateDirectory, options.runId, review.review_round);
  if (
    source.requestSha256 !== review.revision_request_sha256 ||
    source.request.previous_verdict_sha256 !== review.verdict_sha256 ||
    source.request.previous_published_commit_sha !== review.published_commit_sha ||
    source.request.previous_pr_head_sha !== review.fresh_attested_head_sha ||
    source.request.pull_request_number !== review.pull_request_number
  ) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Sealed Phase 7 revision request no longer matches its terminal Web Review authority.");
  }

  return {
    revisionRound: review.review_round,
    revisionRequestSha256: source.requestSha256,
    verdictSha256: review.verdict_sha256,
    decisionEventSha256: review.decision_event_sha256,
    publishedCommitSha: review.published_commit_sha,
    pullRequestNumber: review.pull_request_number,
    freshAttestedHeadSha: review.fresh_attested_head_sha,
  };
}

async function prepareRuntimeDirectory(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory, "revision-runtime");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(runtime);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(runtime) !== runtime) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision runtime directory must be a canonical real directory.");
  const hooks = path.join(runtime, "empty-hooks");
  await fs.mkdir(hooks, { mode: 0o700 }).catch(async (error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const hookStat = await fs.lstat(hooks);
  if (hookStat.isSymbolicLink() || !hookStat.isDirectory()) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-hooks path is unsafe.");
  const config = path.join(runtime, "empty-config");
  try { await fs.writeFile(config, "", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await fs.lstat(config);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-config file is unsafe.");
  }
  return runtime;
}

function collectSecrets(config: Awaited<ReturnType<typeof loadPhase4Config>>): string[] {
  const keys = new Set<string>();
  if (config.publish?.authentication.mode === "https_token") keys.add(config.publish.authentication.token_environment_key);
  if (config.github_pull_request?.authentication.mode === "https_token") keys.add(config.github_pull_request.authentication.token_environment_key);
  return [...keys].map((key) => process.env[key]).filter((value): value is string => typeof value === "string" && value.length >= 8);
}

export async function reviseRunForOrchestration(options: {
  runId: string;
  revisionRound: number;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<RevisionReceipt> {
  let authPath: string | undefined;
  try {
    const runContext = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath);
    if (!runContext.runReceipt.remote_url) throw new OrchestrationError("ORCHESTRATION_REVISION_HISTORY_INVALID", "Canonical run receipt has no trusted remote_url.");
    const config = await loadPhase4Config(options.configPath);
    if (!config.publish) throw new OrchestrationError("ORCHESTRATION_REVISION_CONFIG_INVALID", "Trusted publish configuration is required.");
    const runtimeDirectory = await prepareRuntimeDirectory(options.stateDirectory);
    const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
    const auth = await preparePublishGitSecurity(config.publish, runContext.runReceipt.remote_url, runtimeDirectory, process.env);
    if (auth.mode === "https_token") authPath = auth.askpassScriptPath;
    const runner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth });
    return await reviseRun({
      runId: options.runId,
      revisionRound: options.revisionRound,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      agentClient: new CodexSdkAgentClient(runtime),
      sandbox: new CodexVerificationSandbox(runtime),
      gitRunner: runner,
      secrets: collectSecrets(config),
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    if (authPath) await fs.unlink(authPath).catch(() => undefined);
  }
}
