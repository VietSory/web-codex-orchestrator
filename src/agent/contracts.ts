import type { AgentAssessment, AgentImplementationResult, ReviewResult } from "../execution/contracts.js";

export type AgentRole = "implementer" | "internal_reviewer" | "final_reviewer";
export type AgentOutput = AgentAssessment | AgentImplementationResult | ReviewResult;

export interface AgentTurnRequest {
  role: AgentRole;
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";

  /**
   * Undefined means create a new provider thread.
   * A value means reconstruct or resume that exact logical provider thread.
   */
  thread_id?: string;
  prompt: string;
  output_schema: Record<string, unknown>;

  read_only: boolean;
  approval_policy: "never";
  sandbox_mode: "read-only" | "workspace-write";
  network_access: false;
  live_web_search: false;
  cached_web_search: false;
  /** Canonical project root granted to the trusted orchestrator. */
  workspace_path: string;
  /** Accepted bundle is read-only context and is never a writable root. */
  accepted_bundle_path: string;
  signal?: AbortSignal;
}

export interface AgentTurnResponse {
  thread_id: string;
  output: unknown;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  public_events?: Array<{ type: string; timestamp: string }>;
}

/**
 * Provider runtime boundary. Implementations own provider-specific logical
 * thread creation/reconstruction, while WCO only supplies validated requests.
 */
export interface AgentClient {
  /**
   * Resolve the configured provider runtime and perform a credential-free
   * readiness preflight before any model turn is started. Browser transports
   * may observe cancellation so doctor deadlines cancel the actual probe.
   */
  checkAvailability(options?: { signal?: AbortSignal }): Promise<void>;
  turn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
}
