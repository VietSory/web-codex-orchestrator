import { ExecutionError } from "../execution/errors.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

export interface SupportedCodexSdk { run(request: AgentTurnRequest): Promise<AgentTurnResponse>; }

/** Optional adapter for a supported Codex SDK. No provider dependency is loaded
 * in tests, and an absent runtime fails closed. */
export class CodexSdkAgentClient implements AgentClient {
  constructor(private readonly sdk?: SupportedCodexSdk) {}
  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (!this.sdk) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex SDK runtime was not provided.");
    return this.sdk.run(request);
  }
}
