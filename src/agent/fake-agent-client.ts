import type { AgentClient, AgentRole, AgentThread, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

export type FakeResponse = unknown | ((request: AgentTurnRequest) => unknown | Promise<unknown>);

export class FakeAgentClient implements AgentClient {
  readonly calls: AgentTurnRequest[] = [];
  readonly threads: string[] = [];
  private index = 0;
  constructor(private readonly responses: FakeResponse[] = []) {}
  async checkAvailability(): Promise<void> { return undefined; }
  async startThread(request: Omit<AgentTurnRequest, "thread_id">): Promise<AgentThread> {
    const threadId = `${request.role}-fake-thread-${this.threads.length + 1}`;
    this.threads.push(threadId);
    return { thread_id: threadId };
  }
  async resumeThread(threadId: string): Promise<AgentThread> {
    if (!threadId) throw new Error("threadId is required");
    return { thread_id: threadId };
  }
  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.calls.push({ ...request });
    const value = this.responses[Math.min(this.index++, Math.max(0, this.responses.length - 1))];
    const output = typeof value === "function" ? await value(request) : value ?? this.defaultOutput(request.role);
    const threadId = request.thread_id ?? `${request.role}-fake-thread-${this.threads.length + 1}`;
    if (!this.threads.includes(threadId)) this.threads.push(threadId);
    return { thread_id: threadId, output };
  }
  private defaultOutput(role: AgentRole): unknown {
    if (role === "implementer") return { status: "READY_FOR_VERIFICATION", summary: "fake implementation", changed_files_claimed: [], acceptance_evidence: [], tests_added_or_changed: [], unresolved_issues: [], human_action: null };
    if (role === "internal_reviewer" || role === "final_reviewer") return { verdict: "APPROVE", reviewed_change_set_sha256: "0".repeat(64), summary: "fake review", acceptance_results: [], blocking_findings: [], non_blocking_findings: [], scope_violations: [], unverified_acceptance: [], recommended_next_state: "SOL_REVIEWING", human_action: null };
    return { status: "COMPATIBLE", summary: "fake assessment", repository_observations: [], bundle_conflicts: [], missing_prerequisites: [], human_action: null };
  }
}
