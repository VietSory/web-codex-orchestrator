import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { WcoBrowserCompanionMode } from "../agent/wco-browser-companion-protocol.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const TEMPORARY_CHAT_URL = `${CHATGPT_ORIGIN}/?temporary-chat=true`;
const POLL_MS = 250;
const DEFAULT_LOGIN_SECONDS = 120;
const DEFAULT_RESPONSE_SECONDS = 900;
const MODE_LABELS: Record<WcoBrowserCompanionMode, string> = {
  instant: "Instant",
  medium: "Medium",
  high: "High",
  "extra-high": "Extra High",
  pro: "Pro",
  luna: "Luna",
};

type JsonObject = Record<string, unknown>;
type PendingCdp = { resolve: (value: JsonObject) => void; reject: (error: Error) => void };

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
}

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

interface BrowserSession {
  targetId: string;
  sessionId: string;
}

export interface WcoBrowserSessionEvidence {
  authenticated: true;
  temporary: true;
  url: string;
  available_modes: WcoBrowserCompanionMode[];
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : codedError("WCO_BROWSER_COMPANION_ABORTED", "Browser companion operation was aborted.");
  }
}

function boundedSeconds(value: string | undefined, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function isExactChatGptUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "chatgpt.com"
      && parsed.port === ""
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function temporaryUrlProof(value: string): boolean {
  if (!isExactChatGptUrl(value)) return false;
  const parsed = new URL(value);
  return parsed.searchParams.get("temporary-chat") === "true";
}

function normalizeModelMenuEntry(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function menuEntryMatchesMode(entry: string, mode: WcoBrowserCompanionMode): boolean {
  const text = normalizeModelMenuEntry(entry);
  const wanted = normalizeModelMenuEntry(MODE_LABELS[mode]);
  return text === wanted || text.startsWith(`${wanted} `);
}

export function detectModesFromMenuEntries(entries: readonly string[]): WcoBrowserCompanionMode[] {
  const order: readonly WcoBrowserCompanionMode[] = ["instant", "medium", "high", "extra-high", "pro", "luna"];
  return order.filter((mode) => entries.some((entry) => menuEntryMatchesMode(entry, mode)));
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdp>();

  private constructor(private readonly socket: MinimalWebSocket) {}

  static async connect(url: string, signal?: AbortSignal): Promise<CdpConnection> {
    abortIfRequested(signal);
    const Constructor = (globalThis as unknown as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
    if (!Constructor) {
      throw codedError("WCO_BROWSER_COMPANION_RUNTIME_UNAVAILABLE", "Native browser companion requires WebSocket support.");
    }
    const socket = new Constructor(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      const onAbort = () => {
        try { socket.close(); } catch { /* exact socket only */ }
        finish(codedError("WCO_BROWSER_COMPANION_ABORTED", "Browser companion operation was aborted."));
      };
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* exact socket only */ }
        finish(codedError("WCO_BROWSER_COMPANION_CDP_TIMEOUT", "Timed out connecting to the native browser debugging endpoint."));
      }, 10_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", () => finish());
      socket.addEventListener("error", () => finish(codedError("WCO_BROWSER_COMPANION_CDP_UNAVAILABLE", "Cannot connect to the native browser debugging endpoint.")));
    });
    const connection = new CdpConnection(socket);
    socket.addEventListener("message", (event) => connection.onMessage(event));
    socket.addEventListener("close", () => connection.failPending(codedError("WCO_BROWSER_COMPANION_CDP_CLOSED", "Native browser debugging connection closed.")));
    return connection;
  }

  private onMessage(event: unknown): void {
    const data = event && typeof event === "object" && "data" in event ? (event as { data?: unknown }).data : undefined;
    if (typeof data !== "string") return;
    let parsed: unknown;
    try { parsed = JSON.parse(data) as unknown; } catch { return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "number") return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
      pending.reject(codedError("WCO_BROWSER_COMPANION_CDP_ERROR", String((record.error as Record<string, unknown>).message ?? "CDP command failed.")));
      return;
    }
    pending.resolve(record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result as JsonObject : {});
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async command(method: string, params: JsonObject = {}, sessionId?: string, signal?: AbortSignal): Promise<JsonObject> {
    abortIfRequested(signal);
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => {
        if (this.pending.delete(id)) reject(codedError("WCO_BROWSER_COMPANION_ABORTED", "Browser companion operation was aborted."));
      }, { once: true });
    });
    try { this.socket.send(JSON.stringify(payload)); } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error instanceof Error ? error : codedError("WCO_BROWSER_COMPANION_CDP_UNAVAILABLE", "Cannot send native browser command."));
    }
    return await response;
  }

  close(): void {
    this.failPending(codedError("WCO_BROWSER_COMPANION_CDP_CLOSED", "Native browser debugging connection closed."));
    try { this.socket.close(); } catch { /* exact socket only */ }
  }
}

function standardBrowserCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA || "";
  return [
    env.WCO_BROWSER_COMPANION_BROWSER_EXECUTABLE || "",
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
}

async function firstExisting(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* next bounded candidate */ }
  }
  throw codedError("WCO_BROWSER_COMPANION_BROWSER_MISSING", "WCO could not find a supported Windows Chrome/Edge executable.");
}

function defaultProfileDirectory(env: NodeJS.ProcessEnv): string {
  const root = env.LOCALAPPDATA?.trim();
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) {
    throw codedError("WCO_BROWSER_COMPANION_PROFILE_UNAVAILABLE", "Windows LOCALAPPDATA is unavailable for the WCO browser profile.");
  }
  return path.join(root, "WCO", "browser-companion", "profile");
}

async function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("exit", () => finish(true));
  });
}

export class WcoWindowsChatGptBrowserTransport {
  private connection: CdpConnection | null = null;
  private browser: ChildProcess | null = null;
  private profileDirectory: string | null = null;
  private readonly loginSeconds: number;
  private readonly responseSeconds: number;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (process.platform !== "win32") {
      throw codedError("WCO_BROWSER_COMPANION_WINDOWS_REQUIRED", "The WCO browser transport must run natively on Windows.");
    }
    this.loginSeconds = boundedSeconds(env.WCO_BROWSER_COMPANION_LOGIN_SECONDS, DEFAULT_LOGIN_SECONDS, 900);
    this.responseSeconds = boundedSeconds(env.WCO_BROWSER_COMPANION_RESPONSE_SECONDS, DEFAULT_RESPONSE_SECONDS, 3600);
  }

  private async devToolsSocket(profileDirectory: string): Promise<string | null> {
    const source = await readFile(path.join(profileDirectory, "DevToolsActivePort"), "utf8").catch(() => null);
    if (!source) return null;
    const [portLine, socketPath] = source.trim().split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !socketPath?.startsWith("/devtools/browser/")) return null;
    return `ws://127.0.0.1:${port}${socketPath}`;
  }

  private async ensureConnection(signal?: AbortSignal): Promise<CdpConnection> {
    if (this.connection) return this.connection;
    abortIfRequested(signal);
    const executable = await firstExisting(standardBrowserCandidates(this.env));
    const profileDirectory = defaultProfileDirectory(this.env);
    this.profileDirectory = profileDirectory;
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await unlink(path.join(profileDirectory, "DevToolsActivePort")).catch(() => undefined);

    const marker = crypto.randomUUID();
    const child = spawn(executable, [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--wco-browser-instance=${marker}`,
      "--no-first-run",
      "--no-default-browser-check",
      TEMPORARY_CHAT_URL,
    ], { stdio: "ignore", shell: false, windowsHide: false });
    this.browser = child;

    const deadline = Date.now() + 20_000;
    let socket: string | null = null;
    while (Date.now() < deadline && !socket) {
      abortIfRequested(signal);
      socket = await this.devToolsSocket(profileDirectory);
      if (!socket) await sleep(POLL_MS);
    }
    if (!socket) {
      await this.close();
      throw codedError("WCO_BROWSER_COMPANION_START_FAILED", "Chrome/Edge did not expose its loopback-only DevTools endpoint.");
    }
    try {
      this.connection = await CdpConnection.connect(socket, signal);
      await this.connection.command("Browser.getVersion", {}, undefined, signal);
      return this.connection;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async openTemporarySession(signal?: AbortSignal): Promise<BrowserSession> {
    const cdp = await this.ensureConnection(signal);
    const created = await cdp.command("Target.createTarget", { url: TEMPORARY_CHAT_URL }, undefined, signal);
    if (typeof created.targetId !== "string") throw codedError("WCO_BROWSER_COMPANION_CDP_ERROR", "Browser did not return a target ID.");
    const attached = await cdp.command("Target.attachToTarget", { targetId: created.targetId, flatten: true }, undefined, signal);
    if (typeof attached.sessionId !== "string") throw codedError("WCO_BROWSER_COMPANION_CDP_ERROR", "Browser did not return a session ID.");
    await cdp.command("Runtime.enable", {}, attached.sessionId, signal);
    await cdp.command("Page.enable", {}, attached.sessionId, signal);
    return { targetId: created.targetId, sessionId: attached.sessionId };
  }

  private async evaluate(session: BrowserSession, expression: string, signal?: AbortSignal): Promise<unknown> {
    const cdp = await this.ensureConnection(signal);
    const result = await cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session.sessionId, signal);
    const remote = result.result;
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) return undefined;
    return (remote as Record<string, unknown>).value;
  }

  private async pageState(session: BrowserSession, signal?: AbortSignal): Promise<{
    composer: boolean;
    protective: boolean;
    url: string;
    assistants: number;
    stop: boolean;
    text: string;
    body: string;
  }> {
    const value = await this.evaluate(session, `(() => {
      const body = document.body?.innerText || '';
      const composer = !!document.querySelector('#prompt-textarea');
      const protective = /verify you are human|checking your browser|captcha|unusual activity/i.test(body);
      const assistants = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const last = assistants.length ? assistants[assistants.length - 1] : null;
      const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]');
      return { composer, protective, url: location.href, assistants: assistants.length, stop, text: last?.innerText || '', body };
    })()`, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw codedError("WCO_BROWSER_COMPANION_DOM_INVALID", "ChatGPT page state is unavailable.");
    }
    const item = value as Record<string, unknown>;
    return {
      composer: item.composer === true,
      protective: item.protective === true,
      url: typeof item.url === "string" ? item.url : "",
      assistants: typeof item.assistants === "number" ? item.assistants : 0,
      stop: item.stop === true,
      text: typeof item.text === "string" ? item.text : "",
      body: typeof item.body === "string" ? item.body : "",
    };
  }

  private async waitForComposer(session: BrowserSession, signal?: AbortSignal): Promise<ReturnType<WcoWindowsChatGptBrowserTransport["pageState"]> extends Promise<infer T> ? T : never> {
    const deadline = Date.now() + this.loginSeconds * 1_000;
    while (Date.now() < deadline) {
      abortIfRequested(signal);
      const state = await this.pageState(session, signal);
      if (state.protective) {
        throw codedError("WCO_BROWSER_COMPANION_PROTECTIVE_MEASURE", "ChatGPT displayed a protective verification step; WCO will not bypass it.");
      }
      if (state.composer) return state;
      await sleep(POLL_MS);
    }
    throw codedError("WCO_BROWSER_COMPANION_AUTH_REQUIRED", "ChatGPT is not signed in in the WCO Windows browser profile. Complete sign-in in the opened browser and retry.");
  }

  private temporaryProof(state: { url: string; body: string }): boolean {
    return temporaryUrlProof(state.url) || /\bTemporary Chat\b/i.test(state.body);
  }

  private async openModelMenu(session: BrowserSession, signal?: AbortSignal): Promise<string[]> {
    const value = await this.evaluate(session, `(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
      const selector = buttons.find((button) => {
        const text = ((button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '')).trim();
        return /model|chatgpt|gpt|instant|medium|high|pro|luna/i.test(text) && (button.getAttribute('aria-haspopup') === 'menu' || /model/i.test(button.getAttribute('data-testid') || ''));
      });
      if (!selector) return [];
      selector.click();
      return [((selector.textContent || '') + ' ' + (selector.getAttribute('aria-label') || '')).trim()];
    })()`, signal);
    await sleep(350);
    const options = await this.evaluate(session, `(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], button'))
      .filter((element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })
      .map((element) => (element.textContent || '').trim())
      .filter(Boolean))()`, signal);
    const current = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    const menu = Array.isArray(options) ? options.filter((entry): entry is string => typeof entry === "string") : [];
    return [...current, ...menu];
  }

  private async selectMode(session: BrowserSession, mode: WcoBrowserCompanionMode, signal?: AbortSignal): Promise<void> {
    const menuText = await this.openModelMenu(session, signal);
    const label = MODE_LABELS[mode];
    if (!menuText.some((entry) => menuEntryMatchesMode(entry, mode))) {
      await this.evaluate(session, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); true`, signal);
      throw codedError("WCO_BROWSER_COMPANION_MODE_UNAVAILABLE", `ChatGPT account/UI does not expose requested mode '${mode}'.`);
    }
    const clicked = await this.evaluate(session, `(() => {
      const wanted = ${JSON.stringify(normalizeModelMenuEntry(label))};
      const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], button'));
      const match = candidates.find((element) => {
        const text = (element.textContent || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (text === wanted || text.startsWith(wanted + ' '));
      });
      if (!match) return false;
      match.click();
      return true;
    })()`, signal);
    if (clicked !== true) throw codedError("WCO_BROWSER_COMPANION_MODE_SELECT_FAILED", `Could not select ChatGPT mode '${mode}'.`);
    await sleep(300);
  }

  private async detectModes(session: BrowserSession, signal?: AbortSignal): Promise<WcoBrowserCompanionMode[]> {
    const entries = await this.openModelMenu(session, signal);
    await this.evaluate(session, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); true`, signal);
    return detectModesFromMenuEntries(entries);
  }

  private async sendPrompt(session: BrowserSession, prompt: string, signal?: AbortSignal): Promise<number> {
    const before = await this.pageState(session, signal);
    const focused = await this.evaluate(session, `(() => { const element = document.querySelector('#prompt-textarea'); if (!element) return false; element.focus(); return true; })()`, signal);
    if (focused !== true) throw codedError("WCO_BROWSER_COMPANION_COMPOSER_UNAVAILABLE", "ChatGPT prompt composer is unavailable.");
    const cdp = await this.ensureConnection(signal);
    await cdp.command("Input.insertText", { text: prompt }, session.sessionId, signal);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sent = await this.evaluate(session, `(() => {
        const button = document.querySelector('button[data-testid="send-button"]') || Array.from(document.querySelectorAll('button')).find((candidate) => /send message/i.test(candidate.getAttribute('aria-label') || ''));
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`, signal);
      if (sent === true) return before.assistants;
      await sleep(POLL_MS);
    }
    throw codedError("WCO_BROWSER_COMPANION_SEND_FAILED", "ChatGPT send control did not become available.");
  }

  private async waitForResponse(session: BrowserSession, assistantsBefore: number, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.responseSeconds * 1_000;
    let lastText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      abortIfRequested(signal);
      const state = await this.pageState(session, signal);
      if (state.protective) throw codedError("WCO_BROWSER_COMPANION_PROTECTIVE_MEASURE", "ChatGPT displayed a protective verification step; WCO will not bypass it.");
      if (!isExactChatGptUrl(state.url)) throw codedError("WCO_BROWSER_COMPANION_ORIGIN_DRIFT", "ChatGPT browser target left the exact chatgpt.com origin.");
      if (state.assistants > assistantsBefore && state.text.trim()) {
        if (state.text === lastText && !state.stop) {
          if (stableSince === 0) stableSince = Date.now();
          if (Date.now() - stableSince >= 1_500) return state.text;
        } else {
          lastText = state.text;
          stableSince = 0;
        }
      }
      await sleep(POLL_MS);
    }
    throw codedError("WCO_BROWSER_COMPANION_RESPONSE_TIMEOUT", "ChatGPT Web did not finish the native browser response before the configured deadline.");
  }

  async inspect(signal?: AbortSignal): Promise<WcoBrowserSessionEvidence> {
    const session = await this.openTemporarySession(signal);
    const state = await this.waitForComposer(session, signal);
    if (!isExactChatGptUrl(state.url) || !this.temporaryProof(state)) {
      throw codedError("WCO_BROWSER_COMPANION_TEMPORARY_REQUIRED", "WCO browser did not prove a real ChatGPT Temporary Chat before the provider turn.");
    }
    const modes = await this.detectModes(session, signal);
    return { authenticated: true, temporary: true, url: state.url, available_modes: modes };
  }

  async run(prompt: string, mode: WcoBrowserCompanionMode, signal?: AbortSignal): Promise<{ text: string; evidence: WcoBrowserSessionEvidence }> {
    const session = await this.openTemporarySession(signal);
    const state = await this.waitForComposer(session, signal);
    if (!isExactChatGptUrl(state.url) || !this.temporaryProof(state)) {
      throw codedError("WCO_BROWSER_COMPANION_TEMPORARY_REQUIRED", "WCO browser did not prove a real ChatGPT Temporary Chat before the provider turn.");
    }
    const modes = await this.detectModes(session, signal);
    if (!modes.includes(mode)) {
      throw codedError("WCO_BROWSER_COMPANION_MODE_UNAVAILABLE", `Requested mode '${mode}' is not exposed by the signed-in ChatGPT account.`);
    }
    await this.selectMode(session, mode, signal);
    const assistantsBefore = await this.sendPrompt(session, prompt, signal);
    const text = await this.waitForResponse(session, assistantsBefore, signal);
    return {
      text,
      evidence: { authenticated: true, temporary: true, url: state.url, available_modes: modes },
    };
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try { await connection.command("Browser.close"); } catch { /* exact WCO-owned browser only */ }
      try { connection.close(); } catch { /* exact socket only */ }
    }
    const browser = this.browser;
    this.browser = null;
    if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
    if (await waitForExit(browser, 2_000)) return;
    if (browser.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true });
      await waitForExit(killer, 2_000);
    }
  }
}
