import { ExecutionError, isExecutionError } from "../execution/errors.js";
import type { AgentClient, AgentThread, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";
import path from "node:path";

export interface SupportedCodexSdk {
  /** Optional provider-specific auth check. It must not return credentials. */
  checkAuth?: () => Promise<boolean | void>;
  startThread(request: Omit<AgentTurnRequest, "thread_id">): Promise<AgentThread>;
  resumeThread(threadId: string): Promise<AgentThread>;
  run(request: AgentTurnRequest): Promise<AgentTurnResponse>;
}

/** Optional adapter for a supported Codex SDK. No provider dependency is loaded
 * in tests, and an absent runtime fails closed. */
export class CodexSdkAgentClient implements AgentClient {
  constructor(private readonly sdk?: SupportedCodexSdk) {}
  async checkAvailability(): Promise<void> {
    if (!this.sdk) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex SDK runtime was not provided.");
    if (!this.sdk.checkAuth) throw new ExecutionError("CODEX_AUTH_UNAVAILABLE", "The configured Codex SDK did not expose an authentication preflight.");
    try {
      const available = await this.sdk.checkAuth();
      if (available === false) throw new ExecutionError("CODEX_AUTH_UNAVAILABLE", "Codex authentication is unavailable.");
    } catch (error) {
      if (isExecutionError(error)) throw error;
      throw new ExecutionError("CODEX_AUTH_UNAVAILABLE", "Codex authentication preflight failed.");
    }
  }
  private validateRequest(request: AgentTurnRequest): void {
    if (request.approval_policy !== "never" || request.network_access !== false || request.live_web_search !== false || request.cached_web_search !== false) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Codex approval, network, and web-search access must be restricted.");
    if (!request.workspace_path || !request.accepted_bundle_path) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Codex workspace and read-only bundle roots are required.");
    const workspace = path.resolve(request.workspace_path);
    const bundle = path.resolve(request.accepted_bundle_path);
    if (workspace === bundle || workspace.startsWith(`${bundle}${path.sep}`) || bundle.startsWith(`${workspace}${path.sep}`)) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "The accepted bundle must remain outside the writable workspace root.");
    if (request.read_only && request.sandbox_mode !== "read-only") throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Read-only Codex turns require read-only sandbox mode.");
    if (!request.read_only && request.sandbox_mode !== "workspace-write") throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Implementation turns require workspace-write sandbox mode.");
  }
  async startThread(request: Omit<AgentTurnRequest, "thread_id">): Promise<AgentThread> {
    if (!this.sdk) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex SDK runtime was not provided.");
    this.validateRequest(request);
    try { return await this.sdk.startThread(request); }
    catch (error) { if (isExecutionError(error)) throw error; throw new ExecutionError("CODEX_TURN_FAILED", "Codex thread creation failed."); }
  }
  async resumeThread(threadId: string): Promise<AgentThread> {
    if (!this.sdk) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex SDK runtime was not provided.");
    try { return await this.sdk.resumeThread(threadId); }
    catch (error) { if (isExecutionError(error)) throw error; throw new ExecutionError("CODEX_TURN_FAILED", "Codex thread resume failed."); }
  }
  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (!this.sdk) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex SDK runtime was not provided.");
    this.validateRequest(request);
    try { return await this.sdk.run(request); }
    catch (error) { if (isExecutionError(error)) throw error; throw new ExecutionError("CODEX_TURN_FAILED", "Codex turn failed."); }
  }
}
