import test from "node:test";

const enabled = process.env.WCO_RUN_CODEX_INTEGRATION === "1";
const runtimeConfigured = typeof process.env.WCO_CODEX_INTEGRATION_MODULE === "string" && process.env.WCO_CODEX_INTEGRATION_MODULE.length > 0;

test("optional real Codex integration is opt-in and never runs in normal CI", { skip: !enabled || !runtimeConfigured }, async (context) => {
  // The adapter module is deliberately supplied by a human-run environment;
  // normal CI has no credentials and never imports a provider runtime.
  if (!runtimeConfigured) { context.skip("No supported Codex runtime module configured."); return; }
  const module = await import(process.env.WCO_CODEX_INTEGRATION_MODULE!);
  if (!module.default || typeof module.default.run !== "function" || typeof module.default.startThread !== "function" || typeof module.default.resumeThread !== "function") context.skip("Configured module does not expose the SupportedCodexSdk contract.");
});
