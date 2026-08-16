import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import type { TrustedConfig } from "../config/contracts.js";
import { defaultAgentLimits } from "../execution/budget.js";
import { ensureChatGptLogin } from "../runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import type { SemanticChallengeTransport } from "../semantic/challenge-aware-web-bridge.js";
import { createSemanticChallengeRequest, type SemanticChallengeRequest, type SemanticUnderstandingEnvelope } from "../semantic/blind-challenge.js";
import { runSemanticChallengeShadow } from "../semantic/challenge-shadow-runner.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { ChatGptCodexWebBridge } from "./chatgpt-codex-bridge.js";
import { ChatGptCodexSemanticChallengeTransport } from "./chatgpt-codex-semantic-challenge-transport.js";
import { ChatGptCodexSemanticClient } from "./chatgpt-codex-semantic-client.js";
import { WebBridgeError, contentDigest, type BridgeJobIdentity, type RepositoryCommandResult } from "./contracts.js";
import type { AuthoringJobRequest } from "./web-bridge.js";

/**
 * Normal ChatGPT/Codex bridge plus the optional blind semantic-challenge
 * capability. All existing WebBridge and prepared-run authority stays inherited
 * unchanged from ChatGptCodexWebBridge. The shadow challenge starts beside normal
 * authoring but is fail-open and cannot alter the authoring identity or workflow.
 */
export class ChatGptCodexChallengeWebBridge extends ChatGptCodexWebBridge implements SemanticChallengeTransport {
  private readonly challengeStateDirectory: string;
  private readonly challengeScratchDirectory: string;
  private readonly challengeAuthorityDirectory: string;
  private challengeProviderPromise: Promise<ChatGptCodexSemanticChallengeTransport> | null = null;
  private readonly challengeRuns = new Set<Promise<void>>();

  constructor(private readonly challengeConfig: TrustedConfig, bridgeDirectory: string, stateDirectory = path.join(path.dirname(path.resolve(bridgeDirectory)), "state")) {
    super(challengeConfig, bridgeDirectory, stateDirectory);
    this.challengeStateDirectory = path.resolve(stateDirectory);
    const resolvedBridge = path.resolve(bridgeDirectory);
    this.challengeScratchDirectory = path.join(resolvedBridge, "chatgpt-codex-runtime", "semantic-challenge-scratch");
    this.challengeAuthorityDirectory = path.join(resolvedBridge, "chatgpt-codex-runtime", "semantic-challenge-authority");
  }

  private async challengeProvider(): Promise<ChatGptCodexSemanticChallengeTransport> {
    if (!this.challengeProviderPromise) {
      this.challengeProviderPromise = (async () => {
        const profile = this.challengeConfig.agents?.final_reviewer;
        if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Semantic challenger profile is missing.");
        const limits = this.challengeConfig.agents?.limits ?? defaultAgentLimits();

        // Authorization is resolved before provider construction rather than via
        // a callback immediately before the turn. The provider/client boundary
        // intentionally has no arbitrary pre-turn callback seam.
        const authorized = await ensureChatGptLogin({ config: this.challengeConfig, stateDirectory: this.challengeStateDirectory });
        if (!authorized) throw new WebBridgeError("CODEX_AUTH_UNAVAILABLE", "ChatGPT authorization is required. Run `wco web connect` in an interactive terminal.");

        const runtime = await resolveCodexRuntime(this.challengeConfig.runtime, this.challengeStateDirectory);
        const client = new ChatGptCodexSemanticClient(new CodexSdkAgentClient(runtime), limits.maximum_turn_seconds);

        // The provider and semantic client independently require canonical,
        // empty, disjoint challenge-only roots before every challenge turn.
        // Establish them one component at a time without recursive mkdir through
        // unattested ancestry; later replacement, deletion or contamination
        // still fails closed instead of being recreated.
        await ensureCanonicalDirectory(this.challengeScratchDirectory, "semantic challenge scratch");
        await ensureCanonicalDirectory(this.challengeAuthorityDirectory, "semantic challenge authority");

        return new ChatGptCodexSemanticChallengeTransport({
          client,
          profile,
          limits,
          scratchDirectory: this.challengeScratchDirectory,
          authorityDirectory: this.challengeAuthorityDirectory,
        });
      })();
    }
    return await this.challengeProviderPromise;
  }

  private async runAuthoringChallenge(request: AuthoringJobRequest, authoringIdentity: BridgeJobIdentity, repositoryPath: string): Promise<void> {
    try {
      const transport = await this.challengeProvider();
      const challenge = createSemanticChallengeRequest({
        challengeId: `shadow-${contentDigest({ job_id: authoringIdentity.job_id, repository: request.repository, goal: request.user_intent }).slice(0, 48)}`,
        repository: request.repository,
        originalGoal: request.user_intent,
      });
      await runSemanticChallengeShadow({
        transport,
        request: challenge,
        repositoryPath,
        stateDirectory: this.challengeStateDirectory,
      });
    } catch {
      // Deliberately fail-open: this independent challenger is evidence/quality
      // shadow only and must never change normal authoring or workflow authority.
    }
  }

  override async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    const identity = await super.createAuthoringJob(request, idempotencyKey);
    const configuredRepository = this.challengeConfig.repositories[request.repository.repository_id];
    if (configuredRepository) {
      const run = this.runAuthoringChallenge(request, identity, configuredRepository.path);
      this.challengeRuns.add(run);
      void run.finally(() => { this.challengeRuns.delete(run); });
    }
    return identity;
  }

  async createSemanticChallengeJob(request: SemanticChallengeRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    return await (await this.challengeProvider()).createSemanticChallengeJob(request, idempotencyKey);
  }

  async waitForSemanticChallengeAction(jobId: string, afterSequence: number, signal?: AbortSignal) {
    return await (await this.challengeProvider()).waitForSemanticChallengeAction(jobId, afterSequence, signal);
  }

  async submitSemanticChallengeRepositoryResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> {
    await (await this.challengeProvider()).submitSemanticChallengeRepositoryResult(jobId, result, idempotencyKey);
  }

  async receiveSemanticUnderstanding(jobId: string): Promise<SemanticUnderstandingEnvelope | null> {
    return await (await this.challengeProvider()).receiveSemanticUnderstanding(jobId);
  }
}
