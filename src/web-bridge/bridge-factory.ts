import type { TrustedConfig } from "../config/contracts.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { ManualFileWebBridge } from "./manual-file-bridge.js";
import { RelayFileStore } from "./relay/file-store.js";
import type { WebBridge } from "./web-bridge.js";

export function createConfiguredWebBridge(config: TrustedConfig, bridgeDirectory: string, env: NodeJS.ProcessEnv = process.env): WebBridge { if (config.web_bridge?.mode === "actions_relay") { if (!config.web_bridge.relay_url) throw new Error("WEB_RELAY_NOT_CONFIGURED: relay_url is required."); return new ActionRelayWebBridge({ relayUrl: config.web_bridge.relay_url, token: async () => { const token = env.WCO_RELAY_TOKEN; if (!token) throw new Error("WEB_RELAY_AUTH_UNAVAILABLE"); return token; } }); } return new ManualFileWebBridge(new RelayFileStore(bridgeDirectory)); }
