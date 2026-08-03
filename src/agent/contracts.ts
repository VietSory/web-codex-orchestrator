import type { AgentAssessment, AgentImplementationResult, ReviewResult } from "../execution/contracts.js";

export type AgentRole = "implementer" | "internal_reviewer" | "final_reviewer";
export type AgentOutput = AgentAssessment | AgentImplementationResult | ReviewResult;

export interface AgentTurnRequest {
  role: AgentRole;
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";

  /**
   * Undefined means create a new SDK thread.
   * A value means reconstruct that thread through resumeThread().
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
  /** Canonical project root granted to the agent by the trusted orchestrator. */
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
 * Runtime boundary for Codex.  Implementations own provider-specific thread
 * creation/resume, while the orchestrator only supplies validated requests.
 */
export interface AgentClient {
  /** Resolve the configured runtime and perform a credential-free auth
   * preflight before any model thread is started. */
  checkAvailability(): Promise<void>;
  turn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
}
