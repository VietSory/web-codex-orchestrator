import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

export interface ModelTurnReservation {
  role: AgentTurnRequest["role"];
  model: string;
}

/**
 * Decorates an AgentClient with a durable pre-call reservation hook.
 * The hook runs immediately before every provider-backed turn; if it rejects,
 * the underlying model call is never started.
 */
export class ReservedAgentClient implements AgentClient {
  constructor(
    private readonly inner: AgentClient,
    private readonly beforeTurn: (reservation: ModelTurnReservation) => Promise<void>,
  ) {}

  async checkAvailability(): Promise<void> {
    await this.inner.checkAvailability();
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    await this.beforeTurn({ role: request.role, model: request.model });
    return await this.inner.turn(request);
  }
}
