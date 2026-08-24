import { createProductionBrowserReviewer } from "../executor/browser-reviewer.js";
import { createProductionVerifier } from "../executor/production-gates.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import type { ExecutorReviewerPort } from "../executor/gates.js";
import type { LifecycleSnapshot } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition, type ContinueResult, type OrchestrationDependencies } from "./transition-runner.js";
import { OrchestrationError } from "./contracts.js";

function browserPairEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.WCO_CHATGPT_BROWSER?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const unreachableReviewer: ExecutorReviewerPort = {
  async review() { throw new Error("PAIR_WEB_REVIEW_BOUNDARY: model reviewer must never run in legacy PAIR Harness execution."); },
};

const legacyPairHarnessDependencies: Pick<OrchestrationDependencies, "createExecutorGates" | "executePack"> = {
  async createExecutorGates(options) {
    return { verifier: await createProductionVerifier(options), reviewer: unreachableReviewer };
  },
  async executePack(options) {
    return await executeRegisteredWebPack({
      runId: options.runId,
      artifactSha256: options.artifactSha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      verifier: options.verifier,
      reviewStrategy: "web",
    });
  },
};

const browserPairHarnessDependencies: Pick<OrchestrationDependencies, "createExecutorGates" | "executePack"> = {
  async createExecutorGates(options) {
    const [verifier, reviewer] = await Promise.all([
      createProductionVerifier(options),
      createProductionBrowserReviewer(options),
    ]);
    return { verifier, reviewer };
  },
  async executePack(options) {
    if (!options.reviewer) throw new OrchestrationError("ORCHESTRATION_PAIR_BROWSER_REVIEWER_REQUIRED", "Browser PAIR cannot publish without its independent ChatGPT Web reviewer.");
    return await executeRegisteredWebPack({
      runId: options.runId,
      artifactSha256: options.artifactSha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      verifier: options.verifier,
      reviewer: options.reviewer,
      reviewStrategy: "model",
    });
  },
};

export function assertPairHarnessReadyForCodeReview(last: ContinueResult | null, snapshot: LifecycleSnapshot): void {
  if (snapshot.result_bundle_ready) return;
  const diagnostic = last?.ledger.diagnostics.at(-1);
  throw new OrchestrationError(
    diagnostic?.code ?? "ORCHESTRATION_PAIR_HARNESS_INCOMPLETE",
    diagnostic?.message ?? "PAIR Harness stopped before producing its exact reviewed Draft PR Result Bundle.",
  );
}

/**
 * Drive PAIR through Web-pack registration, Harness apply/verification,
 * publication, Draft PR and Result Bundle.
 *
 * Normal legacy PAIR preserves the historical post-publication Web-review
 * boundary. Direct browser PAIR (`WCO_CHATGPT_BROWSER=1`) instead runs exactly
 * one independent ChatGPT Web reviewer inside the Harness after deterministic
 * verification and before READY_FOR_PUBLISH. APPROVE proceeds to publication;
 * one bounded REVISE repair is applied and re-verified before publication;
 * ESCALATE or an invalid repair stops safely without creating a PR.
 */
export async function drivePairHarnessToCodeReview(options: {
  runId: string;
  webPackPath: string;
  stateDirectory: string;
  configPath: string;
  maxTransitions?: number;
}): Promise<{ last: ContinueResult | null; snapshot: LifecycleSnapshot }> {
  const maximum = Math.max(1, Math.min(options.maxTransitions ?? 8, 16));
  const dependencies = browserPairEnabled() ? browserPairHarnessDependencies : legacyPairHarnessDependencies;
  let last: ContinueResult | null = null;
  let suppliedPack = false;
  for (let index = 0; index < maximum; index += 1) {
    last = await runNextTransition({
      runId: options.runId,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(suppliedPack ? {} : { inputs: { web_pack_path: options.webPackPath } }),
      dependencies,
    });
    suppliedPack = true;
    const snapshot = await readLifecycleSnapshot(options.stateDirectory, options.runId);
    if (snapshot.result_bundle_ready) break;
    if (last.needs_input === "web_verdict_path" || ["WAIT_HUMAN", "DONE"].includes(last.planned.transition) || !last.progressed) break;
  }
  const snapshot = await readLifecycleSnapshot(options.stateDirectory, options.runId);
  assertPairHarnessReadyForCodeReview(last, snapshot);
  return { last, snapshot };
}
