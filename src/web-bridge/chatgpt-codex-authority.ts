import {
  parseRepositoryCommand,
  parseWebContractEnvelope,
  parseWebImplementationSubmission,
  parseWebVerdictEnvelope,
  type RepositoryCommand,
  type WebContractEnvelope,
  type WebImplementationSubmission,
  type WebVerdictEnvelope,
} from "./contracts.js";
import { CHATGPT_CODEX_PROTOCOL_VERSION } from "./chatgpt-codex-output-schema.js";

export type ChatGptCodexAuthority =
  | { kind: "repository_command"; value: RepositoryCommand }
  | { kind: "contract_sealed"; value: WebContractEnvelope }
  | { kind: "implementation_sealed"; value: WebImplementationSubmission }
  | { kind: "web_verdict"; value: WebVerdictEnvelope };

export function parseChatGptCodexAuthority(input: unknown): ChatGptCodexAuthority {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("WEB_CHATGPT_CODEX_OUTPUT_INVALID: provider envelope must be an object.");
  const envelope = input as Record<string, unknown>;
  if (envelope.protocol_version !== CHATGPT_CODEX_PROTOCOL_VERSION || typeof envelope.kind !== "string" || typeof envelope.payload_json !== "string") throw new Error("WEB_CHATGPT_CODEX_OUTPUT_INVALID: provider envelope is invalid.");
  if (Object.keys(envelope).some((key) => !["protocol_version", "kind", "payload_json"].includes(key))) throw new Error("WEB_CHATGPT_CODEX_OUTPUT_INVALID: provider envelope contains an unknown field.");
  let payload: unknown;
  try { payload = JSON.parse(envelope.payload_json); }
  catch { throw new Error("WEB_CHATGPT_CODEX_OUTPUT_INVALID: payload_json must contain valid JSON."); }

  switch (envelope.kind) {
    case "repository_command": return { kind: "repository_command", value: parseRepositoryCommand(payload) };
    case "contract_sealed": return { kind: "contract_sealed", value: parseWebContractEnvelope(payload) };
    case "implementation_sealed": return { kind: "implementation_sealed", value: parseWebImplementationSubmission(payload) };
    case "web_verdict": return { kind: "web_verdict", value: parseWebVerdictEnvelope(payload) };
    default: throw new Error("WEB_CHATGPT_CODEX_OUTPUT_INVALID: provider action kind is invalid.");
  }
}
