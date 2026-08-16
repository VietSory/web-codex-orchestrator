const MAX_AUDITED_PUBLIC_EVENTS = 256;

const ALLOWED_PROMPT_ONLY_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "reasoning",
  "todo_list",
  "agent_message",
  "turn.completed",
]);

/**
 * Provider-backed semantic A/B is intended to measure policy applied only to
 * the public benchmark case. Codex read-only sandboxes constrain mutation but
 * can still expose broader local read capability, so an accepted benchmark
 * turn must prove from the SDK event stream that no local/external tool was
 * used. If the bounded event stream reaches its audit cap, fail closed because
 * later tool activity could otherwise be hidden by truncation.
 */
export function assertPromptOnlySemanticBenchmarkTurn(
  events: ReadonlyArray<{ type: string }> | undefined,
): void {
  if (!events || events.length === 0) {
    throw new Error("semantic provider benchmark is missing the provider public event audit trail.");
  }
  if (events.length >= MAX_AUDITED_PUBLIC_EVENTS) {
    throw new Error("semantic provider benchmark public event audit trail reached its truncation bound.");
  }

  let threadStarted = 0;
  let turnCompleted = 0;
  let agentMessages = 0;
  for (const event of events) {
    if (!ALLOWED_PROMPT_ONLY_EVENT_TYPES.has(event.type)) {
      throw new Error(`semantic provider benchmark observed forbidden provider tool/event '${event.type}'.`);
    }
    if (event.type === "thread.started") threadStarted += 1;
    else if (event.type === "turn.completed") turnCompleted += 1;
    else if (event.type === "agent_message") agentMessages += 1;
  }

  if (threadStarted !== 1 || turnCompleted !== 1 || agentMessages < 1) {
    throw new Error("semantic provider benchmark public event lifecycle is incomplete or ambiguous.");
  }
}
