import http from "node:http";
import { WebBridgeError } from "./contracts.js";
import type { ManagedPairingAuthority } from "./managed-service-runtime.js";
import { ManagedServiceRuntime } from "./managed-service-runtime.js";
import { PersonalBearerAuthenticator, type RelayPrincipal } from "./relay/auth.js";

/**
 * Dynamic relay authenticator for the managed deployment. It deliberately
 * subclasses the legacy bearer authenticator only to remain compatible with the
 * existing bounded relay server surface; all real authorization comes from the
 * scoped managed pairing authority.
 */
export class ManagedRelayAuthenticator extends PersonalBearerAuthenticator {
  constructor(private readonly pairing: ManagedPairingAuthority) {
    super([{ owner: "managed-bootstrap-unused", token: "x".repeat(32) }]);
  }

  override authenticate(header: string | undefined): RelayPrincipal {
    const match = header?.match(/^Bearer ([^\s]+)$/);
    if (!match || match[1]!.length < 32 || match[1]!.length > 4096) throw new WebBridgeError("RELAY_UNAUTHORIZED", "Managed bearer authentication is required.");
    try { return { owner: this.pairing.authenticate(match[1]!, "wco.relay").account_id }; }
    catch { throw new WebBridgeError("RELAY_UNAUTHORIZED", "Managed bearer authentication failed."); }
  }
}

/**
 * HTTP listener for `/v1/managed/*`. A deployment can route that prefix here
 * and all bounded relay routes to `createRelayServer` behind the SAME public
 * HTTPS origin. No endpoint in this server has local repository authority.
 */
export function createManagedControlPlaneServer(runtime: ManagedServiceRuntime): http.Server {
  return http.createServer(async (request, response) => {
    const handled = await runtime.handle(request, response);
    if (!handled && !response.headersSent) {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
    }
  });
}
