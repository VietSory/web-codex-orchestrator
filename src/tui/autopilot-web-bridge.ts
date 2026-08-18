import type { AuthoringJobRequest, WebBridge } from "../web-bridge/web-bridge.js";
import type {
  AuthoringEvent,
  BridgeConnectionStatus,
  BridgeJobIdentity,
  FinalReviewRequest,
  RepositoryCommandResult,
  WebContractEnvelope,
  WebImplementationSubmission,
  WebVerdictEnvelope,
} from "../web-bridge/contracts.js";

export function withFinalReviewNotification(
  bridge: WebBridge,
  notify: (reviewId: string) => Promise<void> | void,
  assertHealthy?: (reviewId: string) => Promise<void>,
): WebBridge {
  const notified = new Set<string>();

  const notifyOnce = async (reviewId: string): Promise<void> => {
    if (notified.has(reviewId)) return;
    // Mark only after a required native notification succeeds; otherwise a
    // retry must be able to launch the same idempotent Workspace Agent run.
    try {
      await notify(reviewId);
      notified.add(reviewId);
    } catch (error) {
      if (assertHealthy) throw error;
      // Browser/UI notification is advisory for non-native transports and must
      // never become orchestration authority.
      notified.add(reviewId);
    }
  };

  return {
    createAuthoringJob: async (request: AuthoringJobRequest, key: string): Promise<BridgeJobIdentity> =>
      await bridge.createAuthoringJob(request, key),
    waitForAuthoringEvent: async (jobId: string, after: number, signal?: AbortSignal): Promise<AuthoringEvent | null> =>
      await bridge.waitForAuthoringEvent(jobId, after, signal),
    submitRepositoryCommandResult: async (jobId: string, result: RepositoryCommandResult, key: string): Promise<void> =>
      await bridge.submitRepositoryCommandResult(jobId, result, key),
    submitClarification: async (jobId: string, text: string, key: string): Promise<void> =>
      await bridge.submitClarification(jobId, text, key),
    receiveSealedContract: async (jobId: string): Promise<WebContractEnvelope | null> =>
      await bridge.receiveSealedContract(jobId),
    receiveWebImplementation: async (jobId: string): Promise<WebImplementationSubmission | null> =>
      await bridge.receiveWebImplementation(jobId),
    ...(bridge.preflightFinalReviewEvidence
      ? {
          preflightFinalReviewEvidence: async (evidence: Record<string, unknown>): Promise<void> =>
            await bridge.preflightFinalReviewEvidence!(evidence),
        }
      : {}),
    createFinalReviewJob: async (request: FinalReviewRequest, key: string): Promise<BridgeJobIdentity> =>
      await bridge.createFinalReviewJob(request, key),
    submitFinalReviewEvidence: async (reviewId: string, evidence: Record<string, unknown>, key: string): Promise<void> =>
      await bridge.submitFinalReviewEvidence(reviewId, evidence, key),
    waitForVerdict: async (reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> => {
      await notifyOnce(reviewId);
      const verdict = await bridge.waitForVerdict(reviewId, signal);
      if (!verdict && assertHealthy) await assertHealthy(reviewId);
      return verdict;
    },
    getConnectionStatus: async (): Promise<BridgeConnectionStatus> => await bridge.getConnectionStatus(),
  };
}
