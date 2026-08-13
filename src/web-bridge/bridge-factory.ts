import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { ManualFileWebBridge } from "./manual-file-bridge.js";
import { RelayFileStore } from "./relay/file-store.js";
import { readRelayToken } from "./relay-credential.js";
import { ManagedWebOnboardingClient } from "./managed-onboarding.js";
import { ManagedAutoWebBridge } from "./managed-auto-web-bridge.js";
import { resolveManagedWebService } from "./managed-service.js";
import type { WebBridge } from "./web-bridge.js";

export function createConfiguredWebBridge(config: TrustedConfig, bridgeDirectory: string, env: NodeJS.ProcessEnv = process.env): WebBridge {
  const credentialsDirectory = path.join(path.dirname(path.resolve(bridgeDirectory)), "credentials");
  if (config.web_bridge?.mode === "managed_actions") {
    const metadata = resolveManagedWebService(env);
    const managed = new ManagedWebOnboardingClient({ metadata, credentialsDirectory });
    const relay = new ActionRelayWebBridge({ relayUrl: metadata.relay_url!, token: async () => await managed.accessToken() });
    return new ManagedAutoWebBridge(relay, managed);
  }
  if (config.web_bridge?.mode === "personal_actions" || config.web_bridge?.mode === "actions_relay") {
    if (!config.web_bridge.relay_url) throw new Error("WEB_RELAY_NOT_CONFIGURED: relay_url is required.");
    return new ActionRelayWebBridge({
      relayUrl: config.web_bridge.relay_url,
      token: async () => await readRelayToken(credentialsDirectory, env),
    });
  }
  // The normal web_native_mcp path and offline manual_file path both use the
  // same owner-local durable mailbox. In native mode the official OpenAI Secure
  // MCP Tunnel reaches the local MCP server; no WCO-hosted relay/control plane
  // receives repository state or mutation authority.
  return new ManualFileWebBridge(new RelayFileStore(bridgeDirectory));
}