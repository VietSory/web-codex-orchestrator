import crypto from "node:crypto";
import { WebBridgeError } from "../contracts.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

interface PendingRegistration {
  registration_id: string;
  device_code_digest: string;
  device_id: string;
  client_nonce_digest: string;
  code_challenge: string;
  scopes: string[];
  expires_at: number;
  account_id: string | null;
  exchanged: boolean;
}

interface RefreshGrant {
  digest: string;
  account_id: string;
  device_id: string;
  scopes: string[];
  expires_at: number;
  revoked: boolean;
}

interface AccessGrant { account_id: string; device_id: string; scopes: string[]; expires_at: number; revoked: boolean; }

export interface ManagedIssuedCredential {
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account_id: string;
  device_id: string;
  scope: string;
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function opaque(prefix: string): string { return `${prefix}-${crypto.randomBytes(32).toString("base64url")}`; }
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new WebBridgeError("WEB_MANAGED_PAIRING_INVALID", `${label} is invalid.`);
  return value;
}

/**
 * Security core for a managed relay deployment. A production adapter must persist
 * this state transactionally and call authorize only after its normal account OAuth
 * session has authenticated the user. Raw device/refresh secrets are never stored.
 */
export class ManagedPairingRegistry {
  private readonly registrations = new Map<string, PendingRegistration>();
  private readonly refreshGrants = new Map<string, RefreshGrant>();
  private readonly accessGrants = new Map<string, AccessGrant>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  register(input: { device_id: string; client_nonce: string; code_challenge: string; scopes: string[]; ttl_seconds?: number }): { registration_id: string; device_code: string; expires_in: number } {
    const deviceId = id(input.device_id, "device_id");
    if (typeof input.client_nonce !== "string" || input.client_nonce.length < 32 || input.client_nonce.length > 256 || !CHALLENGE.test(input.code_challenge)) throw new WebBridgeError("WEB_MANAGED_PAIRING_INVALID", "Pairing nonce or PKCE challenge is invalid.");
    if (!Array.isArray(input.scopes) || !input.scopes.includes("wco.relay") || input.scopes.some((scope) => !/^[a-z][a-z0-9.:-]{0,63}$/.test(scope))) throw new WebBridgeError("WEB_MANAGED_SCOPE_INSUFFICIENT", "Pairing scopes are invalid.");
    const ttl = input.ttl_seconds ?? 600;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900) throw new WebBridgeError("WEB_MANAGED_PAIRING_INVALID", "Pairing TTL is invalid.");
    const registrationId = opaque("registration"), deviceCode = opaque("device");
    this.registrations.set(registrationId, { registration_id: registrationId, device_code_digest: digest(deviceCode), device_id: deviceId, client_nonce_digest: digest(input.client_nonce), code_challenge: input.code_challenge, scopes: [...new Set(input.scopes)].sort(), expires_at: this.now().getTime() + ttl * 1000, account_id: null, exchanged: false });
    return { registration_id: registrationId, device_code: deviceCode, expires_in: ttl };
  }

  authorize(registrationId: string, authenticatedAccountId: string): void {
    const pending = this.pending(registrationId);
    if (pending.exchanged || pending.account_id !== null) throw new WebBridgeError("WEB_MANAGED_PAIRING_REPLAYED", "Pairing authorization was already consumed.");
    pending.account_id = id(authenticatedAccountId, "account_id");
  }

  exchange(input: { registration_id: string; device_code: string; device_id: string; client_nonce: string; code_verifier: string }): ManagedIssuedCredential {
    const pending = this.pending(input.registration_id);
    if (pending.exchanged) throw new WebBridgeError("WEB_MANAGED_PAIRING_REPLAYED", "Pairing exchange was already consumed.");
    if (!pending.account_id) throw new WebBridgeError("WEB_MANAGED_AUTHORIZATION_PENDING", "Pairing is awaiting account authorization.");
    const challenge = typeof input.code_verifier === "string" ? crypto.createHash("sha256").update(input.code_verifier).digest("base64url") : "";
    if (input.device_id !== pending.device_id || digest(input.device_code) !== pending.device_code_digest || digest(input.client_nonce) !== pending.client_nonce_digest || challenge !== pending.code_challenge) throw new WebBridgeError("WEB_MANAGED_PAIRING_REJECTED", "Pairing proof did not match the registered device.");
    pending.exchanged = true;
    return this.issue(pending.account_id, pending.device_id, pending.scopes);
  }

  refresh(refreshToken: string, deviceId: string): ManagedIssuedCredential {
    const grant = this.refreshGrants.get(digest(refreshToken));
    if (!grant || grant.revoked || grant.device_id !== deviceId || grant.expires_at <= this.now().getTime()) throw new WebBridgeError("WEB_MANAGED_RECONNECT_REQUIRED", "Managed device authorization was revoked or expired.");
    grant.revoked = true;
    return this.issue(grant.account_id, grant.device_id, grant.scopes);
  }

  authenticate(accessToken: string, requiredScope: string): { account_id: string; device_id: string } {
    const grant = this.accessGrants.get(digest(accessToken));
    if (!grant || grant.revoked || grant.expires_at <= this.now().getTime() || !grant.scopes.includes(requiredScope)) throw new WebBridgeError("WEB_MANAGED_UNAUTHORIZED", "Managed access credential is invalid, expired, or insufficiently scoped.");
    return { account_id: grant.account_id, device_id: grant.device_id };
  }

  revoke(accessToken: string, deviceId: string): void {
    const access = this.accessGrants.get(digest(accessToken));
    if (!access || access.device_id !== deviceId) return;
    for (const grant of this.accessGrants.values()) if (grant.device_id === deviceId && grant.account_id === access.account_id) grant.revoked = true;
    for (const grant of this.refreshGrants.values()) if (grant.device_id === deviceId && grant.account_id === access.account_id) grant.revoked = true;
  }

  private pending(registrationId: string): PendingRegistration {
    const pending = this.registrations.get(registrationId);
    if (!pending || pending.expires_at <= this.now().getTime()) throw new WebBridgeError("WEB_MANAGED_PAIRING_EXPIRED", "Pairing registration expired or does not exist.");
    return pending;
  }

  private issue(accountId: string, deviceId: string, scopes: string[]): ManagedIssuedCredential {
    const access = opaque("access"), refresh = opaque("refresh");
    this.accessGrants.set(digest(access), { account_id: accountId, device_id: deviceId, scopes, expires_at: this.now().getTime() + 3_600_000, revoked: false });
    this.refreshGrants.set(digest(refresh), { digest: digest(refresh), account_id: accountId, device_id: deviceId, scopes, expires_at: this.now().getTime() + 30 * 24 * 60 * 60 * 1000, revoked: false });
    return { token_type: "Bearer", access_token: access, refresh_token: refresh, expires_in: 3600, account_id: accountId, device_id: deviceId, scope: scopes.join(" ") };
  }
}
