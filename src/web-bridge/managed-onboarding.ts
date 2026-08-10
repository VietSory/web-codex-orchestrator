import crypto from "node:crypto";
import { WebBridgeError, WEB_BRIDGE_PROTOCOL_VERSION, type BridgeConnectionStatus } from "./contracts.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { parseManagedDeviceCredential, readManagedDeviceCredential, removeManagedDeviceCredential, writeManagedDeviceCredential, type ManagedDeviceCredential } from "./managed-credential.js";
import { managedServiceRoute, type ManagedWebServiceMetadata } from "./managed-service.js";

const MAX_RESPONSE_BYTES = 65_536;
const REQUIRED_LOCAL_SCOPE = "wco.relay";

interface DeviceRegistration {
  registration_id: string;
  device_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account_id: string;
  device_id: string;
  scope: string;
}

type Fetcher = typeof fetch;
export interface ManagedServiceStatus { available: true; chatgpt_oauth_configured: boolean; senior_architect_gpt_configured: boolean; }

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", `${label} is invalid.`);
  return value;
}

function cleanVerificationUrl(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Device verification URL is invalid.");
  let url: URL;
  try { url = new URL(value); } catch { throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Device verification URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Device verification URL must use clean HTTPS.");
  return url.href;
}

async function responseJson(response: Response): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length") ?? 0);
  if (advertised > MAX_RESPONSE_BYTES) throw new WebBridgeError("WEB_MANAGED_RESPONSE_LIMIT", "Managed service response exceeded its byte bound.");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WebBridgeError("WEB_MANAGED_RESPONSE_LIMIT", "Managed service response exceeded its byte bound.");
      }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, total);
  try { return bytes.length ? JSON.parse(bytes.toString("utf8")) : null; } catch { throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Managed service response was not JSON."); }
}

async function request(fetcher: Fetcher, url: URL, options: RequestInit): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try { response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.headers ?? {}) } }); }
  catch { throw new WebBridgeError("WEB_MANAGED_RPC_TIMEOUT", "Managed WCO service request failed or timed out."); }
  return { response, body: await responseJson(response) };
}

function registration(value: unknown): DeviceRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Device registration response is invalid.");
  const raw = value as Record<string, unknown>;
  const expires = Number(raw.expires_in), interval = Number(raw.interval);
  if (!Number.isSafeInteger(expires) || expires < 60 || expires > 900 || !Number.isSafeInteger(interval) || interval < 1 || interval > 10) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Device authorization timing is invalid.");
  return { registration_id: identifier(raw.registration_id, "registration_id"), device_code: identifier(raw.device_code, "device_code"), verification_uri_complete: cleanVerificationUrl(raw.verification_uri_complete), expires_in: expires, interval };
}

function tokenCredential(value: unknown, expectedDeviceId: string, now: () => Date): ManagedDeviceCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Managed token response is invalid.");
  const raw = value as Record<string, unknown>;
  const expires = Number(raw.expires_in);
  if (raw.token_type !== "Bearer" || !Number.isSafeInteger(expires) || expires < 60 || expires > 86_400 || raw.device_id !== expectedDeviceId || typeof raw.scope !== "string") throw new WebBridgeError("WEB_MANAGED_RESPONSE_INVALID", "Managed token response binding is invalid.");
  const scopes = raw.scope.split(" ").filter(Boolean);
  if (!scopes.includes(REQUIRED_LOCAL_SCOPE)) throw new WebBridgeError("WEB_MANAGED_SCOPE_INSUFFICIENT", "Managed credential does not grant the local relay scope.");
  return parseManagedDeviceCredential({ schema_version: "1.0", token_type: "Bearer", access_token: raw.access_token, refresh_token: raw.refresh_token, expires_at: new Date(now().getTime() + expires * 1000).toISOString(), account_id: raw.account_id, device_id: raw.device_id, scopes });
}

export class ManagedWebOnboardingClient {
  constructor(private readonly options: { metadata: ManagedWebServiceMetadata; credentialsDirectory: string; fetchImpl?: Fetcher; now?: () => Date; sleep?: (milliseconds: number) => Promise<void> }) {}
  private get fetcher(): Fetcher { return this.options.fetchImpl ?? fetch; }
  private now(): Date { return this.options.now?.() ?? new Date(); }

  async probeServiceStatus(): Promise<ManagedServiceStatus> {
    const { response, body } = await request(this.fetcher, managedServiceRoute(this.options.metadata, "/v1/managed/service/status"), { method: "GET" });
    const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (!response.ok || raw.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION || raw.available !== true || typeof raw.chatgpt_oauth_configured !== "boolean" || typeof raw.senior_architect_gpt_configured !== "boolean") throw new WebBridgeError("WEB_MANAGED_SERVICE_UNAVAILABLE", "Managed WCO Relay is unavailable or incompatible.");
    return { available: true, chatgpt_oauth_configured: raw.chatgpt_oauth_configured, senior_architect_gpt_configured: raw.senior_architect_gpt_configured };
  }

  async probeService(): Promise<void> { await this.probeServiceStatus(); }

  async connect(openAuthorization: (url: string) => Promise<boolean>): Promise<{ credential: ManagedDeviceCredential; status: BridgeConnectionStatus; gpt_url: string; gpt_opened: boolean }> {
    await this.probeService();
    const deviceId = `device-${crypto.randomUUID()}`;
    const nonce = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const created = await request(this.fetcher, managedServiceRoute(this.options.metadata, "/v1/managed/device/registrations"), { method: "POST", body: JSON.stringify({ protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, device_id: deviceId, client_nonce: nonce, code_challenge: challenge, code_challenge_method: "S256", scopes: [REQUIRED_LOCAL_SCOPE] }) });
    if (!created.response.ok) throw new WebBridgeError("WEB_MANAGED_PAIRING_REJECTED", "Managed device registration was rejected.");
    const pending = registration(created.body);
    if (!await openAuthorization(pending.verification_uri_complete)) throw new WebBridgeError("WEB_MANAGED_BROWSER_REQUIRED", `Open the fixed WCO Senior Architect GPT in a browser to connect: ${this.options.metadata.gpt_url}`);
    const deadline = this.now().getTime() + pending.expires_in * 1000;
    let credential: ManagedDeviceCredential | undefined;
    while (this.now().getTime() < deadline) {
      const exchanged = await request(this.fetcher, managedServiceRoute(this.options.metadata, "/v1/managed/device/token"), { method: "POST", body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", registration_id: pending.registration_id, device_code: pending.device_code, device_id: deviceId, client_nonce: nonce, code_verifier: verifier }) });
      if (exchanged.response.ok) { credential = tokenCredential(exchanged.body, deviceId, () => this.now()); break; }
      const error = exchanged.body && typeof exchanged.body === "object" ? String((exchanged.body as any).error ?? "") : "";
      if (exchanged.response.status !== 428 || error !== "authorization_pending") throw new WebBridgeError(error === "expired_token" || error === "access_denied" ? "WEB_MANAGED_PAIRING_REJECTED" : "WEB_MANAGED_RESPONSE_INVALID", "Managed device authorization failed closed.");
      await (this.options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds))))(pending.interval * 1000);
    }
    if (!credential) throw new WebBridgeError("WEB_MANAGED_PAIRING_EXPIRED", "Managed device authorization expired; run /web connect once to retry.");
    await writeManagedDeviceCredential(this.options.credentialsDirectory, credential);
    const bridge = new ActionRelayWebBridge({ relayUrl: this.options.metadata.relay_url!, token: async () => credential!.access_token, fetchImpl: this.fetcher });
    try {
      const status = await bridge.getConnectionStatus();
      if (!status.connected) throw new WebBridgeError("WEB_MANAGED_SERVICE_UNAVAILABLE", "Managed relay did not report a connected device.");
      const gptUrl = this.options.metadata.gpt_url!;
      const gptOpened = pending.verification_uri_complete === gptUrl ? true : await openAuthorization(gptUrl);
      return { credential, status, gpt_url: gptUrl, gpt_opened: gptOpened };
    } catch (error) {
      await removeManagedDeviceCredential(this.options.credentialsDirectory).catch(() => undefined);
      throw error;
    }
  }

  async accessToken(): Promise<string> {
    const credential = await readManagedDeviceCredential(this.options.credentialsDirectory);
    if (Date.parse(credential.expires_at) > this.now().getTime() + 30_000) return credential.access_token;
    const refreshed = await request(this.fetcher, managedServiceRoute(this.options.metadata, "/v1/managed/token/refresh"), { method: "POST", body: JSON.stringify({ grant_type: "refresh_token", refresh_token: credential.refresh_token, device_id: credential.device_id }) });
    if (!refreshed.response.ok) {
      await removeManagedDeviceCredential(this.options.credentialsDirectory).catch(() => undefined);
      throw new WebBridgeError("WEB_MANAGED_RECONNECT_REQUIRED", "WCO device authorization was revoked or expired; reconnect once with /web connect.");
    }
    const next = tokenCredential(refreshed.body, credential.device_id, () => this.now());
    if (next.account_id !== credential.account_id) {
      await removeManagedDeviceCredential(this.options.credentialsDirectory).catch(() => undefined);
      throw new WebBridgeError("WEB_MANAGED_ACCOUNT_MISMATCH", "Managed credential refresh changed account identity and was rejected.");
    }
    await writeManagedDeviceCredential(this.options.credentialsDirectory, next);
    return next.access_token;
  }

  async revokeBestEffort(): Promise<void> {
    let credential: ManagedDeviceCredential;
    try { credential = await readManagedDeviceCredential(this.options.credentialsDirectory); } catch { return; }
    await request(this.fetcher, managedServiceRoute(this.options.metadata, "/v1/managed/device/revoke"), { method: "POST", headers: { Authorization: `Bearer ${credential.access_token}` }, body: JSON.stringify({ device_id: credential.device_id }) }).catch(() => undefined);
    await removeManagedDeviceCredential(this.options.credentialsDirectory);
  }
}
