import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { ChatGptBrowserWebBridge } from "./chatgpt-browser-bridge.js";
import { ChatGptCodexWebBridge } from "./chatgpt-codex-bridge.js";
import { ManualFileWebBridge } from "./manual-file-bridge.js";
import { RelayFileStore } from "./relay/file-store.js";
import { readRelayToken } from "./relay-credential.js";
import { ManagedWebOnboardingClient } from "./managed-onboarding.js";
import { ManagedAutoWebBridge } from "./managed-auto-web-bridge.js";
import { resolveManagedWebService } from "./managed-service.js";
import type { WebBridge } from "./web-bridge.js";

function browserPairOptIn(env: NodeJS.ProcessEnv): boolean {
  const value = env.WCO_CHATGPT_BROWSER?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function createConfiguredWebBridge(config: TrustedConfig, bridgeDirectory: string, env: NodeJS.ProcessEnv = process.env, stateDirectory = path.join(path.dirname(path.resolve(bridgeDirectory)), "state")): WebBridge {
  const credentialsDirectory = path.join(path.dirname(path.resolve(bridgeDirectory)), "credentials");
  // Zero-config normal user path. Explicit web_bridge profiles are advanced
  // compatibility overrides; absence never falls back to a manual mailbox.
  const mode = config.web_bridge?.mode ?? "chatgpt_codex";

  if (mode === "chatgpt_codex") {
    // Browser PAIR is an explicit local-user fallback. Never silently switch a
    // provider after a partially completed Codex turn: the user opts in before
    // the run with WCO_CHATGPT_BROWSER=1, preserving deterministic authority.
    if (browserPairOptIn(env)) return new ChatGptBrowserWebBridge(config, bridgeDirectory, stateDirectory, env);

    // Keep the normal hot path limited to provider work that can affect the
    // user's task. The blind Web-B challenger is qualified research/evaluation
    // infrastructure and remains directly constructible by its benchmark/tests,
    // but it is shadow-only and therefore must not spend extra provider turns,
    // tokens, filesystem work, or authorization latency on every normal task.
    return new ChatGptCodexWebBridge(config, bridgeDirectory, stateDirectory);
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
    // Legacy native-MCP and offline manual-file compatibility paths use the
    // owner-local durable mailbox. Neither is an implicit fallback for the
    // local ChatGPT/Codex transport or any other configured mode.
    return new ManualFileWebBridge(new RelayFileStore(bridgeDirectory));
  }

  const exhaustive: never = mode;
  throw new Error(`WEB_BRIDGE_MODE_UNSUPPORTED: ${exhaustive}`);
}
