export const CHATGPT_CODEX_PROTOCOL_VERSION = "wco-chatgpt-codex-v1" as const;

export const CHATGPT_CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["protocol_version", "kind", "payload_json"],
  properties: {
    protocol_version: { const: CHATGPT_CODEX_PROTOCOL_VERSION },
    kind: { enum: ["repository_command", "contract_sealed", "implementation_sealed", "web_verdict"] },
    payload_json: { type: "string" },
  },
} as const;
