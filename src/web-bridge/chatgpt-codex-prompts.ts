import type { FinalReviewRequest } from "./contracts.js";
import { CHATGPT_CODEX_AUTHOR_PHASE_MARKER, CHATGPT_CODEX_REVIEW_PHASE_MARKER } from "./chatgpt-codex-semantic-client.js";
import type { AuthoringJobRequest } from "./web-bridge.js";

function boundedJson(value: unknown, maximum = 512_000): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximum) throw new Error("WEB_CHATGPT_CODEX_CONTEXT_TOO_LARGE: semantic context exceeded the local bounded prompt budget.");
  return encoded;
}

export function chatGptCodexAuthorPrompt(request: AuthoringJobRequest): string {
  return [
    CHATGPT_CODEX_AUTHOR_PHASE_MARKER,
    "You are WCO's semantic architect. You have no repository mutation authority.",
    "Return exactly one structured provider envelope matching the supplied output schema.",
    "Allowed author actions are repository_command or contract_sealed only. Never return implementation_sealed or web_verdict during authoring.",
    "Inspect repository content only through bounded WCO RepositoryCommand requests. Do not assume unseen files.",
    "When enough exact evidence exists, seal a complete WebContractEnvelope. Delivery must remain Draft PR with auto_merge=false.",
    "Never request secrets, deployment, merge, force-push, direct shell access, or direct Git mutation.",
    `Repository binding: ${boundedJson(request.repository)}`,
    `User intent: ${request.user_intent}`,
    `Mode: ${request.orchestration_mode ?? "PAIR"}`,
  ].join("\n");
}

export function chatGptCodexRepositoryResultPrompt(result: unknown): string {
  return [
    CHATGPT_CODEX_AUTHOR_PHASE_MARKER,
    "WCO executed your exact bounded repository request. Treat this result as authoritative only for the requested repository evidence.",
    boundedJson(result),
    "Return the next repository_command if more exact context is required; otherwise return contract_sealed. Never return implementation_sealed or web_verdict.",
  ].join("\n");
}

export function chatGptCodexReviewPrompt(request: FinalReviewRequest, evidence: Record<string, unknown>): string {
  return [
    CHATGPT_CODEX_REVIEW_PHASE_MARKER,
    "You are WCO's independent final semantic reviewer. You have no mutation, shell, Git, publish, or merge authority.",
    "Review only the exact bounded evidence below and return exactly one web_verdict provider envelope.",
    "APPROVE only when the final Draft PR evidence satisfies the sealed intent and verification. REVISE/BLOCK must contain concrete bounded findings.",
    `Review request: ${boundedJson(request)}`,
    `Exact review evidence: ${boundedJson(evidence)}`,
  ].join("\n");
}
