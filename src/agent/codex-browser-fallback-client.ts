import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

const CHATGPT_THREAD_PREFIX = "https://chatgpt.com/c/";
const QUOTA_PATTERNS = [
  /\busage limit\b/i,
  /\busage[_ -]?limit[_ -]?exceeded\b/i,
  /\bquota\b/i,
  /\bcredits?\b.*\b(?:exhausted|depleted|insufficient|limit|remaining)\b/i,
  /\b(?:exhausted|depleted|insufficient)\b.*\bcredits?\b/i,
  /\bhit (?:your |the )?(?:plan |usage )?limit\b/i,
  /\b(?:plan|usage) limit (?:has been )?(?:reached|exceeded)\b/i,
  /\breset(?:s)? (?:at|in)\b/i,
  /\btry again (?:at|after|in)\b.*\b(?:hour|minute|day|am|pm|utc)\b/i,
] as const;

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCodexAllowanceExhausted(error: unknown): boolean {
  const code = errorCode(error);
  // Authentication, sandbox, schema, interruption and timeout failures are not
  // allowance failures and must never silently select another provider.
  if (code && code !== "CODEX_TURN_FAILED" && code !== "BUDGET_EXHAUSTED") return false;
  const message = errorMessage(error);
  return QUOTA_PATTERNS.some((pattern) => pattern.test(message));
}

export class CodexBrowserFallbackAgentClient implements AgentClient {
  private browserSticky = false;

  constructor(
    private readonly codex: AgentClient,
    private readonly browser: AgentClient,
  ) {}

  async checkAvailability(): Promise<void> {
    if (this.browserSticky) return await this.browser.checkAvailability();
    await this.codex.checkAvailability();
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    const browserThread = request.thread_id?.startsWith(CHATGPT_THREAD_PREFIX) === true;
    if (this.browserSticky || browserThread) {
      this.browserSticky = true;
      return await this.browser.turn(request);
    }

    try {
      return await this.codex.turn(request);
    } catch (error) {
      if (!isCodexAllowanceExhausted(error)) throw error;
      if (request.thread_id) {
        const continuationError = Object.assign(
          new Error("Codex allowance was exhausted after this provider thread had already started. WCO refuses to transplant hidden provider context into a new ChatGPT Web conversation. Start the same goal as a fresh PAIR browser fallback run."),
          { code: "WEB_CHATGPT_BROWSER_MID_THREAD_FALLBACK_UNSAFE", cause: error },
        );
        throw continuationError;
      }
      // Once one first-turn Codex call proves the account allowance exhausted,
      // keep all subsequent new semantic/implementation/review threads on Web
      // for this WCO process. This avoids repeatedly spending failed Codex calls
      // and guarantees that continuation thread IDs remain provider-consistent.
      this.browserSticky = true;
      return await this.browser.turn(request);
    }
  }
}
