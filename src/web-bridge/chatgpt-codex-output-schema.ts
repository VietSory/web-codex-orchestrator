export const CHATGPT_CODEX_PROTOCOL_VERSION = "wco-chatgpt-codex-v1" as const;

function providerSchema(kinds: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["protocol_version", "kind", "payload_json"],
    properties: {
      protocol_version: { const: CHATGPT_CODEX_PROTOCOL_VERSION },
      kind: { enum: kinds },
      payload_json: { type: "string" },
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
 * never author implementation/mutation authority. The independent reviewer
 * may only return a review verdict.
 */
export const CHATGPT_CODEX_AUTHOR_KINDS = ["repository_command", "contract_sealed"] as const;
export const CHATGPT_CODEX_REVIEW_KIND = "web_verdict" as const;
export const CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA = providerSchema(CHATGPT_CODEX_AUTHOR_KINDS);
export const CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA = providerSchema([CHATGPT_CODEX_REVIEW_KIND] as const);

/**
 * Compatibility parser schema for stored/test fixtures only. Production
 * semantic turns must select one of the phase-specific schemas above.
 */
export const CHATGPT_CODEX_OUTPUT_SCHEMA = providerSchema([
  ...CHATGPT_CODEX_AUTHOR_KINDS,
  CHATGPT_CODEX_REVIEW_KIND,
] as const);
