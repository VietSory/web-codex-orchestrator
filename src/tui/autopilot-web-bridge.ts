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
): WebBridge {
  const notified = new Set<string>();

  const notifyOnce = async (reviewId: string): Promise<void> => {
    if (notified.has(reviewId)) return;
    notified.add(reviewId);
    try { await notify(reviewId); } catch { /* UI notification must never become orchestration authority. */ }
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
    createFinalReviewJob: async (request: FinalReviewRequest, key: string): Promise<BridgeJobIdentity> =>
      await bridge.createFinalReviewJob(request, key),
    submitFinalReviewEvidence: async (reviewId: string, evidence: Record<string, unknown>, key: string): Promise<void> =>
      await bridge.submitFinalReviewEvidence(reviewId, evidence, key),
    waitForVerdict: async (reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> => {
      await notifyOnce(reviewId);
      return await bridge.waitForVerdict(reviewId, signal);
    },
    getConnectionStatus: async (): Promise<BridgeConnectionStatus> => await bridge.getConnectionStatus(),
  };
}
