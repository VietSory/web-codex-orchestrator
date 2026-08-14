import type { AgentClient, AgentTurnResponse } from "../agent/contracts.js";
import type { AgentProfile } from "../config/contracts.js";
import { parseWebImplementationSubmission, type WebImplementationSubmission } from "./contracts.js";

const DEFAULT_PROVIDER_TURN_SECONDS = 900;
const MAX_PROVIDER_TURN_SECONDS = 3600;
const implementationOperation = {
  anyOf: [
    { type: "object", additionalProperties: false, properties: { kind: { const: "create" }, path: { type: "string", maxLength: 4096 }, content_base64: { type: "string", maxLength: 700_000 }, content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 } }, required: ["kind", "path", "content_base64", "content_sha256"] },
    { type: "object", additionalProperties: false, properties: { kind: { const: "replace" }, path: { type: "string", maxLength: 4096 }, content_base64: { type: "string", maxLength: 700_000 }, content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 } }, required: ["kind", "path", "content_base64", "content_sha256"] },
    { type: "object", additionalProperties: false, properties: { kind: { const: "delete" }, path: { type: "string", maxLength: 4096 } }, required: ["kind", "path"] },
  ],
} as const;
const sourceReceipt = { type: "object", additionalProperties: false, properties: { url: { type: "string", maxLength: 2048 }, title: { type: "string", maxLength: 512 }, accessed_at: { type: "string", maxLength: 64 }, relevance: { type: "string", maxLength: 4096 } }, required: ["url", "title", "accessed_at", "relevance"] } as const;

export const CHATGPT_CODEX_IMPLEMENTATION_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    protocol_version: { const: "wco-web-bridge-v1" }, job_id: { type: "string", maxLength: 128 }, run_id: { type: "string", maxLength: 256 }, contract_only: { const: false }, summary: { type: "string", maxLength: 16_384 },
    operations: { type: "array", maxItems: 128, items: implementationOperation },
    project_map: { type: "array", maxItems: 2_000, items: { type: "object", additionalProperties: false, properties: { path: { type: "string", maxLength: 4096 }, purpose: { type: "string", maxLength: 4096 } }, required: ["path", "purpose"] } },
    sources: { type: "array", maxItems: 128, items: sourceReceipt },
  },
  required: ["protocol_version", "job_id", "run_id", "contract_only", "summary", "operations", "project_map", "sources"],
} as const;

function timeoutError(): Error & { code: string } { return Object.assign(new Error("Local ChatGPT/Codex implementation planner turn exceeded its bounded deadline."), { code: "WEB_CHATGPT_CODEX_TURN_TIMEOUT" }); }
function measuredUsage(usage: AgentTurnResponse["usage"]): NonNullable<AgentTurnResponse["usage"]> {
  if (!usage || ![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every((value) => Number.isSafeInteger(value) && value >= 0)) throw Object.assign(new Error("Local ChatGPT/Codex implementation provider did not return valid token usage."), { code: "WEB_CHATGPT_CODEX_USAGE_UNAVAILABLE" });
  return usage;
}

export class ChatGptCodexImplementationClient {
  constructor(private readonly agent: AgentClient, private readonly maximumTurnSeconds = DEFAULT_PROVIDER_TURN_SECONDS) {
    if (!Number.isFinite(maximumTurnSeconds) || maximumTurnSeconds <= 0 || maximumTurnSeconds > MAX_PROVIDER_TURN_SECONDS) throw new Error("WEB_CHATGPT_CODEX_CONFIG_INVALID: implementation turn timeout is outside the trusted 1-3600 second range.");
  }

  async propose(options: { profile: AgentProfile; jobId: string; runId: string; workspacePath: string; acceptedBundlePath: string; signal?: AbortSignal }): Promise<{ submission: WebImplementationSubmission; usage: NonNullable<AgentTurnResponse["usage"]> }> {
    const prompt = [
      "You are the WCO Harness implementation planner. You have no direct mutation, Git, publish, merge, credential, or network authority.",
      "Read the exact accepted Task Bundle and repository in read-only mode. Propose the smallest complete implementation that satisfies the frozen contract.",
      "Return full-file postimages as canonical base64 for create/replace operations and lowercase SHA-256 of the decoded bytes. Delete only when the frozen contract requires it.",
      "Do not modify the worktree. Do not commit or push. Do not weaken tests, broaden scope, touch forbidden paths, or invent files outside the accepted path policy.",
      "Use read-only shell commands only when needed to inspect files or calculate exact base64/SHA-256. Never execute repository payloads.",
      "Set sources=[] unless the accepted Task Bundle itself contains source receipts that are directly relevant and can be copied exactly.",
      `Required job_id: ${options.jobId}`, `Required run_id: ${options.runId}`, "Required protocol_version: wco-web-bridge-v1", "Required contract_only: false",
    ].join("\n");
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(this.maximumTurnSeconds * 1_000)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const result = await this.agent.turn({ role: "implementer", model: options.profile.model, reasoning_effort: options.profile.reasoning_effort, prompt, output_schema: CHATGPT_CODEX_IMPLEMENTATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: options.workspacePath, accepted_bundle_path: options.acceptedBundlePath, signal });
      const submission = parseWebImplementationSubmission(result.output);
      if (submission.job_id !== options.jobId || submission.run_id !== options.runId || submission.contract_only) throw new Error("WEB_CHATGPT_CODEX_IMPLEMENTATION_BINDING_MISMATCH: implementation proposal is stale or bound to another canonical run.");
      return { submission, usage: measuredUsage(result.usage) };
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted) throw timeoutError();
      throw error;
    }
  }
}
