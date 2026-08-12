import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";
import { startNativeTunnel } from "./native-tunnel-runtime.js";

export const OPENAI_NATIVE_SETUP_URLS = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  runtime_api_keys: "https://platform.openai.com/settings/organization/api-keys",
  // ChatGPT settings routes are UI-owned and may change. Open the canonical
  // first-party origin and let the guided text direct the user to
  // Settings/Workspace Settings → Apps/Connectors → Create instead of baking a
  // fragile hash route into WCO.
  chatgpt_apps: "https://chatgpt.com/",
  chatgpt_admin: "https://chatgpt.com/admin",
} as const;

export function nativeWorkspaceAgentInstructionsPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/gpt/WCO-SENIOR-ARCHITECT.md");
}

export async function probeNativeOpenAiSetup(options: {
  cacheDirectory: string;
  credential: NativeOpenAiCredential;
  fetchImpl?: typeof fetch;
}): Promise<{ tunnel_ready: true; health_url: string }> {
  const runtime = await startNativeTunnel({ cacheDirectory: options.cacheDirectory, credential: options.credential, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  try { return { tunnel_ready: true, health_url: runtime.health_url }; }
  finally { await runtime.stop(); }
}