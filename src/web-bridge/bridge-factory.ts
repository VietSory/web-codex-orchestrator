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
  const mode = config.web_bridge?.mode ?? "manual_file";

  if (mode === "chatgpt_codex") {
    throw new Error("WEB_CHATGPT_CODEX_NOT_READY: chatgpt_codex is gated until its local semantic bridge and one-authorization acceptance path are fully wired.");
  }
  if (mode === "managed_actions") {
    const metadata = resolveManagedWebService(env);
    const managed = new ManagedWebOnboardingClient({ metadata, credentialsDirectory });
    const relay = new ActionRelayWebBridge({ relayUrl: metadata.relay_url!, token: async () => await managed.accessToken() });
    return new ManagedAutoWebBridge(relay, managed);
  }
  if (mode === "personal_actions" || mode === "actions_relay") {
    if (!config.web_bridge?.relay_url) throw new Error("WEB_RELAY_NOT_CONFIGURED: relay_url is required.");
    return new ActionRelayWebBridge({
      relayUrl: config.web_bridge.relay_url,
      token: async () => await readRelayToken(credentialsDirectory, env),
    });
  }
  if (mode === "web_native_mcp" || mode === "manual_file") {
    // Both legacy native-MCP and offline manual-file compatibility paths use
    // the same owner-local durable mailbox. Native MCP remains advanced-only;
    // it must never become an implicit fallback for another configured mode.
    return new ManualFileWebBridge(new RelayFileStore(bridgeDirectory));
  }

  const exhaustive: never = mode;
  throw new Error(`WEB_BRIDGE_MODE_UNSUPPORTED: ${exhaustive}`);
}
