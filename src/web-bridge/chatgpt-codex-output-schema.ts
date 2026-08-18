export const CHATGPT_CODEX_PROTOCOL_VERSION = "wco-chatgpt-codex-v1" as const;
export const CHATGPT_CODEX_CHALLENGE_PAYLOAD_MAX_CHARS = 2 * 1024 * 1024;

function providerSchema(kinds: readonly string[], payloadMaxLength?: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["protocol_version", "kind", "payload_json"],
    properties: {
      protocol_version: { type: "string", const: CHATGPT_CODEX_PROTOCOL_VERSION },
      kind: { type: "string", enum: kinds },
      payload_json: { type: "string", ...(payloadMaxLength === undefined ? {} : { maxLength: payloadMaxLength }) },
    },
  } as const;
}

/**
 * Provider-facing schemas only. `payload_json` is deliberately opaque here:
 * existing closed WCO validators parse it again locally before any semantic
 * output can become workflow authority.
 *
 * The normal local transport is phase-separated on purpose. The semantic
 * author may only request exact repository context or seal a contract; it can
 * never author implementation/mutation authority. Independent code review has
 * an inspection-only phase that can request repository context but cannot
 * produce a verdict until WCO has durably completed at least one exact source
 * read from the immutable published commit. The normal review phase may then
 * request more bounded context or return a verdict. Neither phase receives
 * shell, network, Git, publish, mutation, or merge authority. The blind
 * challenger may only request bounded repository context or seal a
 * non-authoritative understanding.
 */
export const CHATGPT_CODEX_AUTHOR_KINDS = ["repository_command", "contract_sealed"] as const;
export const CHATGPT_CODEX_REVIEW_INSPECTION_KINDS = ["repository_command"] as const;
export const CHATGPT_CODEX_REVIEW_KINDS = ["repository_command", "web_verdict"] as const;
export const CHATGPT_CODEX_REVIEW_KIND = "web_verdict" as const;
export const CHATGPT_CODEX_CHALLENGE_KINDS = ["repository_command", "semantic_understanding_sealed"] as const;
export const CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA = providerSchema(CHATGPT_CODEX_AUTHOR_KINDS);
export const CHATGPT_CODEX_REVIEW_INSPECTION_OUTPUT_SCHEMA = providerSchema(CHATGPT_CODEX_REVIEW_INSPECTION_KINDS);
export const CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA = providerSchema(CHATGPT_CODEX_REVIEW_KINDS);
export const CHATGPT_CODEX_CHALLENGE_OUTPUT_SCHEMA = providerSchema(CHATGPT_CODEX_CHALLENGE_KINDS, CHATGPT_CODEX_CHALLENGE_PAYLOAD_MAX_CHARS);

/**
 * Compatibility parser schema for stored/test fixtures only. Production
 * semantic turns must select one of the phase-specific schemas above.
 */
export const CHATGPT_CODEX_OUTPUT_SCHEMA = providerSchema([
  "repository_command",
  "contract_sealed",
  "semantic_understanding_sealed",
  CHATGPT_CODEX_REVIEW_KIND,
] as const);
