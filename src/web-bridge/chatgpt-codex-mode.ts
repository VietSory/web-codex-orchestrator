export const CHATGPT_CODEX_WEB_BRIDGE_MODE = "chatgpt_codex" as const;

/**
 * Normal-user transport invariant: this mode uses WCO's bundled official Codex
 * runtime with ChatGPT authorization and must not require relay, tunnel, hosted
 * service, browser scraping, copied credentials, or repository write authority.
 */
export type ChatGptCodexWebBridgeMode = typeof CHATGPT_CODEX_WEB_BRIDGE_MODE;
