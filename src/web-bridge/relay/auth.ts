import crypto from "node:crypto";
import { WebBridgeError } from "../contracts.js";

export interface RelayPrincipal { owner: string; }
export class PersonalBearerAuthenticator {
  private readonly entries: Array<{ owner: string; digest: Buffer }>;
  constructor(tokens: Array<{ owner: string; token: string }>) { this.entries = tokens.map(({ owner, token }) => { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner) || token.length < 32 || token.length > 4096 || /[\r\n\0]/.test(token)) throw new WebBridgeError("RELAY_AUTH_CONFIG_INVALID", "Relay bearer configuration is invalid."); return { owner, digest: crypto.createHash("sha256").update(token).digest() }; }); }
  authenticate(header: string | undefined): RelayPrincipal { const match = header?.match(/^Bearer ([^\s]+)$/); if (!match) throw new WebBridgeError("RELAY_UNAUTHORIZED", "Bearer authentication is required."); const candidate = crypto.createHash("sha256").update(match[1]!).digest(); for (const entry of this.entries) if (crypto.timingSafeEqual(entry.digest, candidate)) return { owner: entry.owner }; throw new WebBridgeError("RELAY_UNAUTHORIZED", "Bearer authentication failed."); }
}
