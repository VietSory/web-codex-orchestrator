import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { writeTrustedConfigAtomic } from "../setup/config-writer.js";
import { createConfiguredWebBridge } from "./bridge-factory.js";
import { configureManagedWebBridgeConnection, configureWebBridgeConnection, disconnectManagedWebBridgeConnection, disconnectWebBridgeConnection } from "./connection-setup.js";
import { PersonalBearerAuthenticator } from "./relay/auth.js";
import { RelayFileStore } from "./relay/file-store.js";
import { createRelayServer } from "./relay/server.js";
import { questionWithoutEcho } from "../shared/secret-prompt.js";
import { resolveManagedWebService } from "./managed-service.js";
import { readManagedDeviceCredential } from "./managed-credential.js";
import { generatePersonalRelaySecret, materializePersonalActionAssets } from "./personal-setup.js";
import { readRelayToken, relayCredentialPath, writeRelayToken } from "./relay-credential.js";
import { readNativeOpenAiCredential, removeNativeOpenAiCredential, writeNativeOpenAiCredential, type NativeOpenAiCredential } from "./native-openai-credential.js";
import { runNativeMcpServer } from "./native-mcp-server.js";
import { nativeWorkspaceAgentInstructionsPath, OPENAI_NATIVE_SETUP_URLS, probeNativeOpenAiSetup } from "./native-web-setup.js";

export interface WebCommandIo {
  write(value: string): void;
  error(value: string): void;
  question?(prompt: string): Promise<string>;
  secret?(prompt: string): Promise<string>;
}

const defaultIo: WebCommandIo = {
  write: (value) => process.stdout.write(value),
  error: (value) => process.stderr.write(value),
};

interface BrowserProcess {
  once(event: "error", listener: (error: Error) => void): BrowserProcess;
  once(event: "spawn", listener: () => void): BrowserProcess;
  unref(): void;
}

type BrowserSpawner = (command: string, args: string[]) => BrowserProcess;
type InteractiveQuestions = {
  question: ((prompt: string) => Promise<string>) | undefined;
  secret: ((prompt: string) => Promise<string>) | undefined;
  close(): void;
};

export async function openBrowser(urlValue: string, spawnBrowser: BrowserSpawner = (command, args) => spawn(command, args, { detached: true, stdio: "ignore", shell: false }) as BrowserProcess): Promise<boolean> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("WEB_GPT_URL_UNSAFE: GPT URL must use clean HTTPS.");
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  return await new Promise<boolean>((resolve) => {
    const child = spawnBrowser(command, [url.href]);
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

/**
 * Explicit /web open helper. Managed normal-user jobs never call a browser per
 * task; they are automatically triggered by the maintainer-operated service.
 */
export async function openConfiguredWebArchitect(config: TrustedConfig): Promise<boolean> {
  if (config.web_bridge?.mode === "managed_actions") return true;
  if (config.web_bridge?.mode === "web_native_mcp") return await openBrowser(OPENAI_NATIVE_SETUP_URLS.chatgpt_apps);
  const gptUrl = config.web_bridge?.gpt_url;
  if (!gptUrl) throw new Error("WEB_GPT_NOT_CONFIGURED: run `wco web connect` first.");
  return await openBrowser(gptUrl);
}

function withDefault(value: string, fallback?: string): string {
  const trimmed = value.trim();
  return trimmed || fallback || "";
}

function formatWebError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  return code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}

function webRecoveryCommand(error: unknown, operation: string): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "WEB_MANAGED_RECONNECT_REQUIRED") return "wco web connect";
  if (code === "WEB_NATIVE_SETUP_REQUIRED" || code === "OPENAI_CAPABILITY_BLOCKED" || code === "WEB_NATIVE_INTERACTION_REQUIRED") return "wco web connect --native";
  if (code === "WEB_MANAGED_OPERATOR_NOT_READY" || code.startsWith("WEB_MANAGED_AGENT_")) return "wco web status";
  if (code === "CONFIG_NOT_FOUND") return "wco setup";
  return `wco web ${operation}`;
}

function interactiveQuestions(io: WebCommandIo): InteractiveQuestions {
  let owned: ReturnType<typeof readline.createInterface> | undefined;
  const question = io.question ?? (process.stdin.isTTY && process.stdout.isTTY ? (() => {
    owned = readline.createInterface({ input: process.stdin, output: process.stdout });
    return async (prompt: string) => await owned!.question(prompt);
  })() : undefined);
  const secret = io.secret ?? (question ? async (prompt: string) => {
    owned?.close();
    owned = undefined;
    const hidden = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try { return await questionWithoutEcho(hidden, prompt, (value) => process.stdout.write(value)); }
    finally { hidden.close(); }
  } : undefined);
  return { question, secret, close: () => { owned?.close(); } };
}

async function promptSelfHostedConnection(io: WebCommandIo, config: TrustedConfig): Promise<{ relayUrl: string; gptUrl: string; token: string } | null> {
  const interactive = interactiveQuestions(io), question = interactive.question;
  if (!question) { io.error("Web connection setup is interactive. Run it in a TTY.\n"); return null; }
  try {
    const currentRelay = config.web_bridge?.mode === "actions_relay" ? config.web_bridge.relay_url : undefined;
    const currentGpt = config.web_bridge?.gpt_url;
    const relayUrl = withDefault(await question(`Relay HTTPS URL${currentRelay ? ` [${currentRelay}]` : ""}: `), currentRelay);
    const gptUrl = withDefault(await question(`WCO Senior Architect GPT URL${currentGpt ? ` [${currentGpt}]` : ""}: `), currentGpt);
    let token = process.env.WCO_RELAY_TOKEN ?? "";
    if (!token) token = (await (interactive.secret ?? question)("Relay bearer token (input hidden; stored only in WCO credentials): ")).trim();
    if (!relayUrl || !gptUrl || !token) { io.error("WEB_CONNECT_CANCELLED: relay URL, GPT URL and relay credential are required.\n"); return null; }
    return { relayUrl, gptUrl, token };
  } finally { interactive.close(); }
}

async function promptPersonalConnection(io: WebCommandIo, config: TrustedConfig): Promise<{ relayUrl: string; gptUrl?: string } | null> {
  const interactive = interactiveQuestions(io), question = interactive.question;
  if (!question) { io.error("Personal Web setup is interactive. Run it in a TTY.\n"); return null; }
  try {
    const currentRelay = config.web_bridge?.mode === "personal_actions" || config.web_bridge?.mode === "actions_relay" ? config.web_bridge.relay_url : undefined;
    const relayUrl = withDefault(await question(`Personal relay HTTPS URL${currentRelay ? ` [${currentRelay}]` : ""}: `), currentRelay);
    if (!relayUrl) { io.error("WEB_PERSONAL_RELAY_REQUIRED: provide a RelayProtocol-compatible HTTPS endpoint for this optional advanced profile.\n"); return null; }
    const currentGpt = config.web_bridge?.gpt_url;
    const gptUrl = withDefault(await question(`Senior Architect GPT URL (optional until advanced setup is complete)${currentGpt ? ` [${currentGpt}]` : ""}: `), currentGpt) || undefined;
    return { relayUrl, ...(gptUrl ? { gptUrl } : {}) };
  } finally { interactive.close(); }
}

/** Advanced/operator-only native setup. It is intentionally not the normal user path. */
async function promptNativeConnection(io: WebCommandIo, openUrl: (url: string) => Promise<boolean>): Promise<NativeOpenAiCredential | null> {
  const interactive = interactiveQuestions(io), question = interactive.question, secret = interactive.secret;
  if (!question || !secret) { io.error("Advanced OpenAI native setup is interactive. Run it in a TTY.\n"); return null; }
  try {
    io.write("Advanced/operator Web-native setup. Normal WCO users should cancel and run `wco web connect` instead.\n\n");
    await openUrl(OPENAI_NATIVE_SETUP_URLS.tunnels);
    const tunnelId = (await question("OpenAI Platform tunnel ID (tunnel_...): ")).trim();
    if (!tunnelId) return null;
    await openUrl(OPENAI_NATIVE_SETUP_URLS.runtime_api_keys);
    const runtimeKey = (await secret("OpenAI tunnel runtime API key (input hidden): ")).trim();
    if (!runtimeKey) return null;
    await openUrl(OPENAI_NATIVE_SETUP_URLS.chatgpt_apps);
    io.write([
      "In ChatGPT Developer/Connector settings, add the WCO MCP app using Tunnel and the tunnel ID above.",
      "The WCO MCP app exposes exact read tools plus three non-destructive semantic submit tools.",
      "Harness alone mutates/verifies the repository.",
    ].join("\n") + "\n");
    await question("Press Enter after the advanced WCO MCP app is saved (or Ctrl+C to stop): ");
    await openUrl(OPENAI_NATIVE_SETUP_URLS.chatgpt_admin);
    io.write([
      "Publish a private WCO Workspace Agent that uses the WCO MCP app.",
      `Use the exact shipped Senior Architect instructions: ${nativeWorkspaceAgentInstructionsPath()}`,
      "Then create an advanced Workspace Agents access token.",
    ].join("\n") + "\n");
    const triggerId = (await question("Workspace Agent API trigger ID (agtch_...): ")).trim();
    const agentToken = (await secret("Workspace Agent access token (input hidden): ")).trim();
    if (!triggerId || !agentToken) return null;
    return { schema_version: "1.0", tunnel_id: tunnelId, control_plane_api_key: runtimeKey, workspace_agent_trigger_id: triggerId, workspace_agent_access_token: agentToken };
  } finally { interactive.close(); }
}

export async function runWebCommand(args: string[], suppliedIo: WebCommandIo = defaultIo, openArchitect: (config: TrustedConfig) => Promise<boolean> = openConfiguredWebArchitect, openUrl: (url: string) => Promise<boolean> = openBrowser): Promise<number> {
  const operation = args[0] ?? "status";
  const io = suppliedIo;
  if (operation === "mcp" && args.length === 1) return await runNativeMcpServer();
  if (operation === "relay") {
    const token = process.env.WCO_RELAY_TOKEN, owner = process.env.WCO_RELAY_OWNER ?? "local";
    if (!token) { io.error("WEB_RELAY_AUTH_UNAVAILABLE: set WCO_RELAY_TOKEN (at least 32 characters).\n"); return 1; }
    const paths = resolveWcoPaths({});
    const port = Number(process.env.WCO_RELAY_PORT ?? 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return 2;
    const server = createRelayServer({ store: new RelayFileStore(`${paths.bridge}/relay`), authenticator: new PersonalBearerAuthenticator([{ owner, token }]) });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
    io.write(`WCO relay listening on http://127.0.0.1:${port}\n`);
    return await new Promise<number>((resolve) => {
      const stop = () => server.close(() => resolve(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }

  const selfHosted = operation === "connect" && args[1] === "--self-hosted" && args.length === 2;
  const nativeConnect = operation === "connect" && args[1] === "--native" && args.length === 2;
  const managedConnect = operation === "connect" && (args.length === 1 || args[1] === "--managed" && args.length === 2);
  const personalSetup = operation === "setup" && args[1] === "--personal" && args.length === 2;
  if (!["status", "open", "connect", "setup", "disconnect"].includes(operation) || operation === "setup" && !personalSetup || operation === "connect" && !(selfHosted || managedConnect || nativeConnect) || args.length > (selfHosted || nativeConnect || personalSetup || args[1] === "--managed" ? 2 : 1)) {
    io.error("Usage: wco web [status|open|connect [--managed|--native|--self-hosted]|setup --personal|disconnect|relay]\n");
    return 2;
  }

  const paths = resolveWcoPaths({});
  try {
    let config = await loadTrustedConfig(paths.config);
    if (personalSetup) {
      let token: string;
      try { token = await readRelayToken(paths.credentials); }
      catch { token = generatePersonalRelaySecret(); await writeRelayToken(paths.credentials, token); }
      const values = await promptPersonalConnection(io, config);
      if (!values) {
        io.write(`Optional personal-relay secret prepared in owner-only WCO storage: ${relayCredentialPath(paths.credentials)}\nThis is an advanced compatibility profile. Normal users run \`wco web connect\` and authorize one browser link.\n`);
        return 1;
      }
      const connected = await configureWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, relayUrl: values.relayUrl, ...(values.gptUrl ? { gptUrl: values.gptUrl } : {}), token, mode: "personal_actions" });
      const assets = await materializePersonalActionAssets(`${paths.cache}/personal-actions`, values.relayUrl);
      config = connected.config;
      io.write(`Optional personal relay  connected\nAuthentication           API key / Bearer\nGPT Action schema        ${assets.openapi_path}\nGPT instructions         ${assets.instructions_path}\n`);
      return values.gptUrl ? 0 : 1;
    }

    if (operation === "connect") {
      if (selfHosted) {
        const values = await promptSelfHostedConnection(io, config);
        if (!values) return 1;
        const connected = await configureWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, relayUrl: values.relayUrl, gptUrl: values.gptUrl, token: values.token });
        config = connected.config;
        io.write("Advanced self-hosted Web bridge connected. Credential stored in WCO-owned credentials.\n");
        return 0;
      }
      if (nativeConnect) {
        const credential = await promptNativeConnection(io, openUrl);
        if (!credential) { io.error("WEB_NATIVE_SETUP_CANCELLED: advanced OpenAI native setup was not completed.\n"); return 1; }
        const credentialPath = await writeNativeOpenAiCredential(paths.credentials, credential);
        try {
          await probeNativeOpenAiSetup({ cacheDirectory: paths.cache, credential });
          const written = await writeTrustedConfigAtomic(paths.config, { ...config, web_bridge: { mode: "web_native_mcp", poll_interval_ms: config.web_bridge?.poll_interval_ms ?? 1_000, job_ttl_seconds: config.web_bridge?.job_ttl_seconds ?? 86_400 } }, { overwrite: true });
          config = written.config;
        } catch (error) {
          await removeNativeOpenAiCredential(paths.credentials).catch(() => undefined);
          throw error;
        }
        io.write(`Advanced OpenAI native transport ready\nCredential storage         ${credentialPath}\n`);
        return 0;
      }

      // Normal path: exactly one browser authorization URL. No IDs, keys,
      // endpoints, schemas, Agent creation, or hosting questions are presented.
      const metadata = resolveManagedWebService();
      io.write("Opening the one-time WCO authorization page...\n");
      const connected = await configureManagedWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, metadata, openAuthorization: openUrl });
      config = connected.config;
      io.write("WCO Web authorization  connected\nChatGPT Web             linked\nCredential              protected + refreshable\nDaily use               run `wco` and type a goal\n");
      return 0;
    }

    if (operation === "open") {
      if (config.web_bridge?.mode === "managed_actions") {
        io.write("Managed ChatGPT Web runs automatically. No per-task browser action is required.\n");
        return 0;
      }
      const opened = await openArchitect(config);
      if (config.web_bridge?.mode === "web_native_mcp") io.write(opened ? "Opened advanced ChatGPT connector settings.\n" : `Open advanced ChatGPT connector settings: ${OPENAI_NATIVE_SETUP_URLS.chatgpt_apps}\n`);
      else io.write(opened ? "Opened the configured advanced WCO Senior Architect GPT.\n" : "Could not open the configured advanced GPT automatically.\n");
      return 0;
    }

    if (operation === "disconnect") {
      if (config.web_bridge?.mode === "web_native_mcp") {
        await removeNativeOpenAiCredential(paths.credentials);
        io.write("Advanced OpenAI native credential removed. Run `wco web connect --native` to configure it again.\n");
      } else if (config.web_bridge?.mode === "managed_actions") {
        let metadata;
        try { metadata = resolveManagedWebService(); } catch { /* local removal must still succeed if operator service is unavailable */ }
        await disconnectManagedWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, ...(metadata ? { metadata } : {}) });
        io.write("WCO Web authorization removed. Your repositories/PRs were not changed. Run `wco web connect` to authorize once again.\n");
      } else {
        await disconnectWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials });
        io.write("Optional relay Web bridge disconnected locally.\n");
      }
      return 0;
    }

    if (config.web_bridge?.mode === "web_native_mcp") {
      await readNativeOpenAiCredential(paths.credentials);
      const bridge = createConfiguredWebBridge(config, paths.bridge), status = await bridge.getConnectionStatus();
      io.write(`Mode                   advanced OpenAI native MCP\nLocal WCO mailbox      ${status.connected ? "ready" : "unavailable"}\nPending author task   ${status.pending_author_job ? "yes" : "none"}\nPending final review  ${status.pending_final_review ? "yes" : "none"}\n`);
      return status.connected ? 0 : 1;
    }
    if (config.web_bridge?.mode === "manual_file" || !config.web_bridge) {
      io.write("Mode                   manual file (advanced/offline)\nWCO Relay              disconnected\nChatGPT Web             not linked\n");
      return 1;
    }
    if (config.web_bridge.mode === "managed_actions") await readManagedDeviceCredential(paths.credentials);
    const bridge = createConfiguredWebBridge(config, paths.bridge);
    const status = await bridge.getConnectionStatus();
    io.write(`Mode                  ${config.web_bridge.mode === "managed_actions" ? "one-link managed Web" : "advanced compatibility"}\nWCO Web service       ${status.connected ? "connected" : "offline"}\nChatGPT Web           ${status.connected ? "linked" : "not linked"}\nPer-task browser      ${config.web_bridge.mode === "managed_actions" ? "not required" : "profile dependent"}\nPending author task   ${status.pending_author_job ? "yes" : "none"}\nPending final review  ${status.pending_final_review ? "yes" : "none"}\n`);
    return status.connected ? 0 : 1;
  } catch (error) {
    io.error(`${formatWebError(error)}\nNo repository files or workflow authority were changed. Next: ${webRecoveryCommand(error, operation)}\n`);
    return 1;
  }
}