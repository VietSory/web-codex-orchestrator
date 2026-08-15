export const CHATGPT_CODEX_WEB_BRIDGE_MODE = "chatgpt_codex" as const;

/**
 * ADR 0004 normal-user transport. WCO uses its bundled official Codex runtime
 * with ChatGPT authorization. This mode must not require relay, tunnel, hosted
 * service, copied credentials, browser scraping, or repository write authority.
 */
export type ChatGptCodexWebBridgeMode = typeof CHATGPT_CODEX_WEB_BRIDGE_MODE;
