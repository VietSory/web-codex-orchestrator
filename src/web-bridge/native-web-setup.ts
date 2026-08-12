import type { NativeOpenAiCredential } from "./native-openai-credential.js";
import { startNativeTunnel } from "./native-tunnel-runtime.js";

export const OPENAI_NATIVE_SETUP_URLS = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  runtime_api_keys: "https://platform.openai.com/settings/organization/api-keys",
  chatgpt_apps: "https://chatgpt.com/plugins",
  chatgpt_admin: "https://chatgpt.com/admin",
} as const;

export async function probeNativeOpenAiSetup(options: {
  cacheDirectory: string;
  credential: NativeOpenAiCredential;
  fetchImpl?: typeof fetch;
}): Promise<{ tunnel_ready: true; health_url: string }> {
  const runtime = await startNativeTunnel({ cacheDirectory: options.cacheDirectory, credential: options.credential, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  try { return { tunnel_ready: true, health_url: runtime.health_url }; }
  finally { await runtime.stop(); }
}
