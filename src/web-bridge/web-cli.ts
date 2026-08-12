import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { createConfiguredWebBridge } from "./bridge-factory.js";
import { configureManagedWebBridgeConnection, configureWebBridgeConnection, disconnectManagedWebBridgeConnection, disconnectWebBridgeConnection } from "./connection-setup.js";
import { PersonalBearerAuthenticator } from "./relay/auth.js";
import { RelayFileStore } from "./relay/file-store.js";
import { createRelayServer } from "./relay/server.js";
import { questionWithoutEcho } from "../shared/secret-prompt.js";
import { resolveManagedWebService } from "./managed-service.js";
import { readManagedDeviceCredential } from "./managed-credential.js";

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

export async function openConfiguredWebArchitect(config: TrustedConfig): Promise<boolean> {
  const gptUrl = config.web_bridge?.mode === "managed_actions" ? resolveManagedWebService().gpt_url : config.web_bridge?.gpt_url;
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
  if (code === "CONFIG_NOT_FOUND") return "wco setup";
  return `wco web ${operation}`;
}

async function promptSelfHostedConnection(io: WebCommandIo, config: TrustedConfig): Promise<{ relayUrl: string; gptUrl: string; token: string } | null> {
  let owned: ReturnType<typeof readline.createInterface> | undefined;
  let secret = io.secret;
  const question = io.question ?? (process.stdin.isTTY && process.stdout.isTTY ? (() => {
    owned = readline.createInterface({ input: process.stdin, output: process.stdout });
    secret = async (prompt: string) => {
      owned?.close();
      owned = undefined;
      const hidden = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      try { return await questionWithoutEcho(hidden, prompt, (value) => process.stdout.write(value)); }
      finally { hidden.close(); }
    };
    return async (prompt: string) => await owned!.question(prompt);
  })() : undefined);
  if (!question) {
    io.error("Web connection setup is interactive. Run it in a TTY.\n");
    return null;
  }
  try {
    const currentRelay = config.web_bridge?.mode === "actions_relay" ? config.web_bridge.relay_url : undefined;
    const currentGpt = config.web_bridge?.gpt_url;
    const relayUrl = withDefault(await question(`Relay HTTPS URL${currentRelay ? ` [${currentRelay}]` : ""}: `), currentRelay);
    const gptUrl = withDefault(await question(`WCO Senior Architect GPT URL${currentGpt ? ` [${currentGpt}]` : ""}: `), currentGpt);
    let token = process.env.WCO_RELAY_TOKEN ?? "";
    if (!token) token = (await (secret ?? question)("Relay bearer token (input hidden; stored only in WCO credentials): ")).trim();
    if (!relayUrl || !gptUrl || !token) {
      io.error("WEB_CONNECT_CANCELLED: relay URL, GPT URL and relay credential are required.\n");
      return null;
    }
    return { relayUrl, gptUrl, token };
  } finally {
    owned?.close();
  }
}

export async function runWebCommand(args: string[], suppliedIo: WebCommandIo = defaultIo, openArchitect: (config: TrustedConfig) => Promise<boolean> = openConfiguredWebArchitect, openUrl: (url: string) => Promise<boolean> = openBrowser): Promise<number> {
  const operation = args[0] ?? "status";
  const io = suppliedIo;
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
  if (!["status", "open", "connect", "disconnect"].includes(operation) || args.length > (selfHosted ? 2 : 1)) {
    io.error("Usage: wco web [status|open|connect [--self-hosted]|disconnect|relay]\n");
    return 2;
  }
  const paths = resolveWcoPaths({});
  try {
    let config = await loadTrustedConfig(paths.config);
    if (operation === "connect") {
      if (selfHosted) {
        const values = await promptSelfHostedConnection(io, config);
        if (!values) return 1;
        const connected = await configureWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, relayUrl: values.relayUrl, gptUrl: values.gptUrl, token: values.token });
        config = connected.config;
        io.write("Advanced self-hosted Web bridge connected. Credential stored in WCO-owned credentials.\n");
        return 0;
      }
      const metadata = resolveManagedWebService();
      io.write("Opening WCO Senior Architect...\n");
      const connected = await configureManagedWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, metadata, openAuthorization: openUrl });
      config = connected.config;
      io.write("WCO Relay             connected\nChatGPT Web            linked\nCredential             protected WCO device storage\n");
      if (!connected.gpt_opened) io.write(`A desktop browser could not be opened. Open the fixed WCO Senior Architect GPT: ${connected.gpt_url}\n`);
      return 0;
    }
    if (operation === "open") {
      const opened = await openArchitect(config);
      const configuredGpt = config.web_bridge?.mode === "managed_actions" ? resolveManagedWebService().gpt_url : config.web_bridge?.gpt_url;
      io.write(opened
        ? "Opened the configured WCO Senior Architect GPT. In ChatGPT, start or continue the pending WCO task.\n"
        : `Could not open a desktop browser automatically. Open the fixed WCO Senior Architect GPT: ${configuredGpt}\n`);
      return 0;
    }
    if (operation === "disconnect") {
      if (config.web_bridge?.mode === "managed_actions") {
        let metadata;
        try { metadata = resolveManagedWebService(); } catch { /* local removal must still succeed if deployment is unavailable */ }
        await disconnectManagedWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials, ...(metadata ? { metadata } : {}) });
        io.write("ChatGPT Web disconnected. WCO removed the local device credential and requested remote revocation when available.\n");
      } else {
        await disconnectWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials });
        io.write("Advanced self-hosted Web bridge disconnected locally.\n");
      }
      return 0;
    }
    if (config.web_bridge?.mode === "manual_file" || !config.web_bridge) {
      io.write("Mode                   manual file (advanced)\nWCO Relay              disconnected\nChatGPT Web             not linked\n");
      return 1;
    }
    if (config.web_bridge.mode === "managed_actions") await readManagedDeviceCredential(paths.credentials);
    const bridge = createConfiguredWebBridge(config, paths.bridge);
    const status = await bridge.getConnectionStatus();
    io.write(`Senior Architect GPT  configured\nWCO Relay              ${status.connected ? "connected" : "offline"}\nChatGPT Web             ${status.connected ? "linked" : "not linked"}\nPending author task    ${status.pending_author_job ? "yes" : "none"}\nPending final review   ${status.pending_final_review ? "yes" : "none"}\n`);
    return status.connected ? 0 : 1;
  } catch (error) {
    io.error(`${formatWebError(error)}\nNo repository files or workflow authority were changed. Next: ${webRecoveryCommand(error, operation)}\n`);
    return 1;
  }
}
