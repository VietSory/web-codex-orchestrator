import { createProductionVerifier } from "../executor/production-gates.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import type { ExecutorReviewerPort } from "../executor/gates.js";
import { readLifecycleSnapshot, type LifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition, type ContinueResult, type OrchestrationDependencies } from "./transition-runner.js";

const unreachableReviewer: ExecutorReviewerPort = {
  async review() { throw new Error("PAIR_WEB_REVIEW_BOUNDARY: model reviewer must never run in PAIR Harness execution."); },
};

const pairHarnessDependencies: Pick<OrchestrationDependencies, "createExecutorGates" | "executePack"> = {
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

/**
 * Drive PAIR through Web-pack registration, Harness apply/verification,
 * publication, Draft PR and Result Bundle. Stop before any Web verdict so an
 * independent Web code-review gate can run first. No model reviewer is created.
 */
export async function drivePairHarnessToCodeReview(options: {
  runId: string;
  webPackPath: string;
  stateDirectory: string;
  configPath: string;
  maxTransitions?: number;
}): Promise<{ last: ContinueResult | null; snapshot: LifecycleSnapshot }> {
  const maximum = Math.max(1, Math.min(options.maxTransitions ?? 8, 16));
  let last: ContinueResult | null = null;
  let suppliedPack = false;
  for (let index = 0; index < maximum; index += 1) {
    last = await runNextTransition({
      runId: options.runId,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(suppliedPack ? {} : { inputs: { web_pack_path: options.webPackPath } }),
      dependencies: pairHarnessDependencies,
    });
    suppliedPack = true;
    if (last.needs_input === "web_verdict_path" || ["WAIT_HUMAN", "DONE"].includes(last.planned.transition) || !last.progressed) break;
  }
  return { last, snapshot: await readLifecycleSnapshot(options.stateDirectory, options.runId) };
}
