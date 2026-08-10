import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { createConfiguredWebBridge } from "./bridge-factory.js";
import { configureWebBridgeConnection, disconnectWebBridgeConnection } from "./connection-setup.js";
import { PersonalBearerAuthenticator } from "./relay/auth.js";
import { RelayFileStore } from "./relay/file-store.js";
import { createRelayServer } from "./relay/server.js";
import { questionWithoutEcho } from "../shared/secret-prompt.js";

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

export function openBrowser(urlValue: string): void {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("WEB_GPT_URL_UNSAFE: GPT URL must use clean HTTPS.");
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url.href], { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

export function openConfiguredWebArchitect(config: TrustedConfig): void {
  if (!config.web_bridge?.gpt_url) throw new Error("WEB_GPT_NOT_CONFIGURED: run `wco web connect` first.");
  openBrowser(config.web_bridge.gpt_url);
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

async function promptConnection(io: WebCommandIo, config: TrustedConfig): Promise<{ relayUrl: string; gptUrl: string; token: string } | null> {
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

export async function runWebCommand(args: string[], suppliedIo: WebCommandIo = defaultIo): Promise<number> {
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
  if (!["status", "open", "connect", "disconnect"].includes(operation) || args.length > 1) {
    io.error("Usage: wco web [status|open|connect|disconnect|relay]\n");
    return 2;
  }
  const paths = resolveWcoPaths({});
  try {
    let config = await loadTrustedConfig(paths.config);
    if (operation === "connect") {
      const values = await promptConnection(io, config);
      if (!values) return 1;
      const connected = await configureWebBridgeConnection({
        configPath: paths.config,
        credentialsDirectory: paths.credentials,
        relayUrl: values.relayUrl,
        gptUrl: values.gptUrl,
        token: values.token,
      });
      config = connected.config;
      io.write(`Web Architect GPT     configured\nRelay                 connected\nAccount               ${connected.status.account ?? "connected"}\nCredential            stored in WCO-owned credentials\n`);
      return 0;
    }
    if (operation === "open") {
      openConfiguredWebArchitect(config);
      io.write("Opened the configured WCO Senior Architect GPT. In ChatGPT, start or continue the pending WCO task.\n");
      return 0;
    }
    if (operation === "disconnect") {
      await disconnectWebBridgeConnection({ configPath: paths.config, credentialsDirectory: paths.credentials });
      io.write("Web bridge disconnected locally. WCO removed its stored relay credential; revoke the server/GPT credential separately if needed.\n");
      return 0;
    }
    if (config.web_bridge?.mode !== "actions_relay") {
      io.write(`Web Architect GPT     ${config.web_bridge?.gpt_url ? "configured" : "missing"}\nRelay                 disconnected\nAccount               missing\nPending author task   none\nPending final review  none\n`);
      return 1;
    }
    const bridge = createConfiguredWebBridge(config, paths.bridge);
    const status = await bridge.getConnectionStatus();
    io.write(`Web Architect GPT     ${config.web_bridge?.gpt_url ? "configured" : "missing"}\nRelay                 ${status.connected ? "connected" : "offline"}\nAccount               ${status.account ?? "missing"}\nPending author task   ${status.pending_author_job ?? "none"}\nPending final review  ${status.pending_final_review ?? "none"}\n`);
    return status.connected ? 0 : 1;
  } catch (error) {
    io.error(`${formatWebError(error)}\nNo repository files or workflow authority were changed. Try: wco web status\n`);
    return 1;
  }
}
