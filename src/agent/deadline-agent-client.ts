import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";
import { ExecutionError } from "../execution/errors.js";

export class DeadlineAgentClient implements AgentClient {
  constructor(
    private readonly inner: AgentClient,
    private readonly maximumTurnSeconds: number,
  ) {
    if (!Number.isSafeInteger(maximumTurnSeconds) || maximumTurnSeconds < 1 || maximumTurnSeconds > 24 * 60 * 60) {
      throw new ExecutionError("EXECUTION_CONFIG_INVALID", "Agent turn deadline must be a bounded positive integer number of seconds.");
    }
  }

  async checkAvailability(): Promise<void> {
    await this.inner.checkAvailability();
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (request.signal?.aborted) throw new ExecutionError("INTERRUPTED", "Agent turn was interrupted before start.");
    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) relayAbort();
    else request.signal?.addEventListener("abort", relayAbort, { once: true });

    const timeoutMs = this.maximumTurnSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Agent turn deadline exceeded."));
        reject(new ExecutionError("CODEX_TURN_TIMEOUT", `Agent ${request.role} turn exceeded the configured ${this.maximumTurnSeconds}s deadline.`));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      const turn = this.inner.turn({ ...request, signal: controller.signal });
      return await Promise.race([turn, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", relayAbort);
    }
  }
}
