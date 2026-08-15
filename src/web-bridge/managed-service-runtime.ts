import type { IncomingMessage, ServerResponse } from "node:http";
import { WebBridgeError, WEB_BRIDGE_PROTOCOL_VERSION } from "./contracts.js";
import type { ManagedAgentPurpose, ManagedAgentRunStatus, ManagedAgentTriggerReceipt } from "./managed-onboarding.js";
import type { ManagedIssuedCredential } from "./relay/managed-pairing.js";
import type { RelayFileStore } from "./relay/file-store.js";
import type { RelayPrincipal } from "./relay/auth.js";
import type { RelayJobRecord } from "./relay/protocol.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY_BYTES = 65_536;

export interface ManagedPairingAuthority {
  register(input: { device_id: string; client_nonce: string; code_challenge: string; scopes: string[]; ttl_seconds?: number }): { registration_id: string; device_code: string; expires_in: number };
  authorize(registrationId: string, authenticatedAccountId: string): void;
  exchange(input: { registration_id: string; device_code: string; device_id: string; client_nonce: string; code_verifier: string }): ManagedIssuedCredential;
  refresh(refreshToken: string, deviceId: string): ManagedIssuedCredential;
  authenticate(accessToken: string, requiredScope: string): { account_id: string; device_id: string };
  revoke(accessToken: string, deviceId: string): void;
}

/**
 * The service owner supplies this adapter. It may redirect through OpenAI/OAuth
 * internally, but the WCO end user clicks only the one verification URL emitted
 * by this runtime. OAuth state/callback security belongs inside this adapter.
 */
export interface ManagedAccountAuthorizationAdapter {
  authenticate(request: IncomingMessage, registrationId: string): Promise<
    | { kind: "authenticated"; account_id: string }
    | { kind: "redirect"; url: string }
  >;
}

/**
 * Provider-side Agent credentials live only behind this adapter. Local WCO
 * clients never receive them. Implementations MUST make trigger idempotent by
 * (account_id,idempotency_key) and honor the supplied deterministic conversation
 * key so final review can resume the exact original Web-A identity.
 */
export interface ManagedAgentGateway {
  ready(): Promise<boolean>;
  trigger(input: {
    account_id: string;
    purpose: ManagedAgentPurpose;
    identity: string;
    conversation_key: string;
    prompt: string;
    idempotency_key: string;
  }): Promise<ManagedAgentTriggerReceipt>;
  status(accountId: string, runId: string): Promise<ManagedAgentRunStatus>;
}

export interface ManagedServiceReadiness {
  chatgpt_oauth_configured: boolean;
  senior_architect_gpt_configured: boolean;
}

function cleanRedirect(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebBridgeError("WEB_MANAGED_AUTH_REDIRECT_INVALID", "Managed authorization redirect is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new WebBridgeError("WEB_MANAGED_AUTH_REDIRECT_INVALID", "Managed authorization redirect must use clean HTTPS.");
  return url.href;
}

function bearer(header: string | undefined): string {
  const match = header?.match(/^Bearer ([^\s]+)$/);
  if (!match || match[1]!.length < 32 || match[1]!.length > 4096) throw new WebBridgeError("WEB_MANAGED_UNAUTHORIZED", "A valid managed bearer credential is required.");
  return match[1]!;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new WebBridgeError("WEB_MANAGED_REQUEST_INVALID", `${label} is invalid.`);
  return value;
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new WebBridgeError("WEB_MANAGED_REQUEST_LIMIT", "Managed request exceeded its byte bound.");
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebBridgeError("WEB_MANAGED_REQUEST_INVALID", "Managed request body must be JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_MANAGED_REQUEST_INVALID", "Managed request body must be an object.");
  return value as Record<string, unknown>;
}

function closed(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new WebBridgeError("WEB_MANAGED_REQUEST_INVALID", `Managed request contains unknown field '${key}'.`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(bytes);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  const bytes = Buffer.from(body);
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(bytes);
}

function implementationRunId(record: RelayJobRecord): string | null {
  if (record.kind !== "authoring") return null;
  const event = record.events.slice().reverse().find((item) => item.type === "implementation_sealed");
  const payload = event?.payload as { submission?: { run_id?: unknown } } | undefined;
  return typeof payload?.submission?.run_id === "string" ? payload.submission.run_id : null;
}

/**
 * Provider-neutral core for the maintainer-operated normal-user service.
 * It deliberately has no repository/shell/Git authority.
 */
export class ManagedServiceRuntime {
  constructor(private readonly options: {
    pairing: ManagedPairingAuthority;
    relayStore: RelayFileStore;
    accountAuthorization: ManagedAccountAuthorizationAdapter;
    agentGateway: ManagedAgentGateway;
    publicOrigin: string;
    readiness: () => Promise<ManagedServiceReadiness>;
  }) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.hash || origin.search || origin.pathname !== "/") throw new WebBridgeError("WEB_MANAGED_PUBLIC_ORIGIN_INVALID", "Managed service publicOrigin must be a clean HTTPS origin.");
  }

  relayAuthenticator(): { authenticate(header: string | undefined): RelayPrincipal } {
    return {
      authenticate: (header) => ({ owner: this.options.pairing.authenticate(bearer(header), "wco.relay").account_id }),
    };
  }

  private authenticate(header: string | undefined): { account_id: string; device_id: string; token: string } {
    const token = bearer(header);
    const principal = this.options.pairing.authenticate(token, "wco.relay");
    return { ...principal, token };
  }

  private async exactConversationKey(accountId: string, purpose: ManagedAgentPurpose, identity: string): Promise<string> {
    safeId(accountId, "account_id");
    safeId(identity, "identity");
    if (purpose === "author") {
      const record = await this.options.relayStore.get(identity, accountId);
      if (record.kind !== "authoring") throw new WebBridgeError("WEB_MANAGED_AGENT_IDENTITY_INVALID", "Author trigger must bind an exact authoring job.");
      return `wco-author-${accountId}-${identity}`;
    }
    const review = await this.options.relayStore.get(identity, accountId);
    if (review.kind !== "final_review") throw new WebBridgeError("WEB_MANAGED_AGENT_IDENTITY_INVALID", "Review trigger must bind an exact review job.");
    if (purpose === "independent_code_review") return `wco-review-${accountId}-${identity}`;

    const runId = typeof (review.request as { run_id?: unknown }).run_id === "string" ? (review.request as { run_id: string }).run_id : null;
    if (!runId) throw new WebBridgeError("WEB_MANAGED_ORIGINAL_AUTHOR_NOT_FOUND", "Final review is missing its exact run identity.");
    const authorJobs = (await this.options.relayStore.list(accountId)).filter((record) => record.kind === "authoring" && implementationRunId(record) === runId);
    if (authorJobs.length !== 1) throw new WebBridgeError("WEB_MANAGED_ORIGINAL_AUTHOR_NOT_FOUND", "Final review could not resolve exactly one original Web-A authoring job.");
    return `wco-author-${accountId}-${authorJobs[0]!.identity.job_id}`;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", this.options.publicOrigin);
    const method = request.method ?? "GET";
    if (!url.pathname.startsWith("/v1/managed/")) return false;

    try {
      if (method === "GET" && url.pathname === "/v1/managed/service/status") {
        const readiness = await this.options.readiness();
        const automatic = await this.options.agentGateway.ready();
        sendJson(response, 200, { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, available: true, chatgpt_oauth_configured: readiness.chatgpt_oauth_configured, senior_architect_gpt_configured: readiness.senior_architect_gpt_configured, automatic_agent_trigger_configured: automatic });
        return true;
      }

      if (method === "POST" && url.pathname === "/v1/managed/device/registrations") {
        const body = await jsonBody(request);
        closed(body, ["protocol_version", "device_id", "client_nonce", "code_challenge", "code_challenge_method", "scopes"]);
        if (body.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION || body.code_challenge_method !== "S256" || !Array.isArray(body.scopes)) throw new WebBridgeError("WEB_MANAGED_PAIRING_INVALID", "Managed registration protocol/PKCE/scopes are invalid.");
        const pending = this.options.pairing.register({ device_id: safeId(body.device_id, "device_id"), client_nonce: String(body.client_nonce ?? ""), code_challenge: String(body.code_challenge ?? ""), scopes: body.scopes.map(String), ttl_seconds: 600 });
        const verification = new URL("/v1/managed/device/authorize", this.options.publicOrigin);
        verification.searchParams.set("registration_id", pending.registration_id);
        sendJson(response, 201, { ...pending, verification_uri_complete: verification.href, interval: 2 });
        return true;
      }

      if (method === "GET" && url.pathname === "/v1/managed/device/authorize") {
        const registrationId = safeId(url.searchParams.get("registration_id"), "registration_id");
        const result = await this.options.accountAuthorization.authenticate(request, registrationId);
        if (result.kind === "redirect") {
          response.writeHead(302, { Location: cleanRedirect(result.url), "Cache-Control": "no-store" });
          response.end();
          return true;
        }
        this.options.pairing.authorize(registrationId, safeId(result.account_id, "account_id"));
        sendHtml(response, 200, "<!doctype html><meta charset=utf-8><title>WCO authorized</title><h1>WCO authorized</h1><p>You can return to your terminal. No further Web setup is required.</p>");
        return true;
      }

      if (method === "POST" && url.pathname === "/v1/managed/device/token") {
        const body = await jsonBody(request);
        closed(body, ["grant_type", "registration_id", "device_code", "device_id", "client_nonce", "code_verifier"]);
        if (body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") throw new WebBridgeError("WEB_MANAGED_PAIRING_INVALID", "Managed device grant type is invalid.");
        try {
          sendJson(response, 200, this.options.pairing.exchange({ registration_id: safeId(body.registration_id, "registration_id"), device_code: String(body.device_code ?? ""), device_id: safeId(body.device_id, "device_id"), client_nonce: String(body.client_nonce ?? ""), code_verifier: String(body.code_verifier ?? "") }));
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "WEB_MANAGED_AUTHORIZATION_PENDING") sendJson(response, 428, { error: "authorization_pending" });
          else throw error;
        }
        return true;
      }

      if (method === "POST" && url.pathname === "/v1/managed/token/refresh") {
        const body = await jsonBody(request);
        closed(body, ["grant_type", "refresh_token", "device_id"]);
        if (body.grant_type !== "refresh_token") throw new WebBridgeError("WEB_MANAGED_REQUEST_INVALID", "Managed refresh grant type is invalid.");
        sendJson(response, 200, this.options.pairing.refresh(String(body.refresh_token ?? ""), safeId(body.device_id, "device_id")));
        return true;
      }

      if (method === "POST" && url.pathname === "/v1/managed/device/revoke") {
        const principal = this.authenticate(request.headers.authorization);
        const body = await jsonBody(request);
        closed(body, ["device_id"]);
        const deviceId = safeId(body.device_id, "device_id");
        if (deviceId !== principal.device_id) throw new WebBridgeError("WEB_MANAGED_FORBIDDEN", "Device revoke identity did not match the authenticated device.");
        this.options.pairing.revoke(principal.token, deviceId);
        sendJson(response, 200, { revoked: true });
        return true;
      }

      if (method === "POST" && url.pathname === "/v1/managed/agent/trigger") {
        const principal = this.authenticate(request.headers.authorization);
        const key = safeId(request.headers["idempotency-key"], "Idempotency-Key");
        const body = await jsonBody(request);
        closed(body, ["purpose", "identity", "input"]);
        const purpose = body.purpose;
        if (purpose !== "author" && purpose !== "independent_code_review" && purpose !== "final_intent_review") throw new WebBridgeError("WEB_MANAGED_AGENT_TRIGGER_INVALID", "Managed agent purpose is invalid.");
        const identity = safeId(body.identity, "identity");
        const prompt = typeof body.input === "string" && body.input.length > 0 && body.input.length <= 65_536 && !body.input.includes("\0") ? body.input : null;
        if (!prompt) throw new WebBridgeError("WEB_MANAGED_AGENT_TRIGGER_INVALID", "Managed agent input is invalid.");
        const conversationKey = await this.exactConversationKey(principal.account_id, purpose, identity);
        const receipt = await this.options.agentGateway.trigger({ account_id: principal.account_id, purpose, identity, conversation_key: conversationKey, prompt, idempotency_key: key });
        sendJson(response, 202, receipt);
        return true;
      }

      const runMatch = url.pathname.match(/^\/v1\/managed\/agent\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const principal = this.authenticate(request.headers.authorization);
        const runId = safeId(decodeURIComponent(runMatch[1]!), "run_id");
        sendJson(response, 200, await this.options.agentGateway.status(principal.account_id, runId));
        return true;
      }

      sendJson(response, 404, { error: "not_found" });
      return true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "WEB_MANAGED_INTERNAL";
      const status = code.includes("UNAUTHORIZED") ? 401 : code.includes("FORBIDDEN") ? 403 : code.includes("EXPIRED") ? 410 : code.includes("REPLAY") || code.includes("CONFLICT") ? 409 : code.includes("LIMIT") ? 413 : 400;
      sendJson(response, status, { error: code, message: error instanceof Error ? error.message : "Managed request failed." });
      return true;
    }
  }
}
