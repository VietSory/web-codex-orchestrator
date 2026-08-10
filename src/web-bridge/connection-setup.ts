import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { writeTrustedConfigAtomic } from "../setup/config-writer.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { removeRelayToken, writeRelayToken } from "./relay-credential.js";
import type { BridgeConnectionStatus } from "./contracts.js";

function requireGptUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || value !== value.trim()) {
    throw new Error("WEB_GPT_URL_UNSAFE: GPT URL must be a clean HTTPS URL.");
  }
  return parsed.href;
}

export async function configureWebBridgeConnection(options: {
  configPath: string;
  credentialsDirectory: string;
  relayUrl: string;
  gptUrl: string;
  token: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ config: TrustedConfig; status: BridgeConnectionStatus; backup_path: string | null }> {
  const current = await loadTrustedConfig(options.configPath);
  const gptUrl = requireGptUrl(options.gptUrl);
  const probe = new ActionRelayWebBridge({ relayUrl: options.relayUrl, token: async () => options.token });
  const status = await probe.getConnectionStatus();
  if (!status.connected) throw new Error("WEB_RELAY_OFFLINE: relay authentication succeeded but the relay did not report a connected state.");
  await writeRelayToken(options.credentialsDirectory, options.token);
  const next: TrustedConfig = {
    ...current,
    web_bridge: {
      mode: "actions_relay",
      relay_url: options.relayUrl,
      gpt_url: gptUrl,
      poll_interval_ms: current.web_bridge?.poll_interval_ms ?? 1_000,
      job_ttl_seconds: current.web_bridge?.job_ttl_seconds ?? 86_400,
    },
  };
  try {
    const written = await writeTrustedConfigAtomic(options.configPath, next, { overwrite: true });
    return { config: written.config, status, backup_path: written.backup_path };
  } catch (error) {
    await removeRelayToken(options.credentialsDirectory).catch(() => undefined);
    throw error;
  }
}

export async function disconnectWebBridgeConnection(options: { configPath: string; credentialsDirectory: string }): Promise<TrustedConfig> {
  const current = await loadTrustedConfig(options.configPath);
  const next: TrustedConfig = {
    ...current,
    web_bridge: {
      mode: "manual_file",
      poll_interval_ms: current.web_bridge?.poll_interval_ms ?? 1_000,
      job_ttl_seconds: current.web_bridge?.job_ttl_seconds ?? 86_400,
    },
  };
  const written = await writeTrustedConfigAtomic(options.configPath, next, { overwrite: true });
  await removeRelayToken(options.credentialsDirectory);
  return written.config;
}
