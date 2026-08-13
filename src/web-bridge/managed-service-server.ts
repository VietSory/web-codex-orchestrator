import http from "node:http";
import { WebBridgeError } from "./contracts.js";
import type { ManagedPairingAuthority } from "./managed-service-runtime.js";
import { ManagedServiceRuntime } from "./managed-service-runtime.js";
import { PersonalBearerAuthenticator, type RelayPrincipal } from "./relay/auth.js";
import type { RelayFileStore } from "./relay/file-store.js";
import { createRelayServer } from "./relay/server.js";

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

/** HTTP listener for only `/v1/managed/*`, useful behind an existing router. */
export function createManagedControlPlaneServer(runtime: ManagedServiceRuntime): http.Server {
  return http.createServer(async (request, response) => {
    const handled = await runtime.handle(request, response);
    if (!handled && !response.headersSent) {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
    }
  });
}

/**
 * Reference same-origin composition used by a production adapter behind TLS.
 * Managed device/Agent routes are handled first; every other `/v1/*` request is
 * delegated to the existing bounded relay using the scoped managed credential.
 *
 * TLS termination/persistence/provider credentials remain operator concerns;
 * end users never configure them.
 */
export function createManagedWcoServiceServer(options: {
  runtime: ManagedServiceRuntime;
  relayStore: RelayFileStore;
  pairing: ManagedPairingAuthority;
}): http.Server {
  const relay = createRelayServer({ store: options.relayStore, authenticator: new ManagedRelayAuthenticator(options.pairing) });
  return http.createServer(async (request, response) => {
    if (await options.runtime.handle(request, response)) return;
    const handled = relay.emit("request", request, response);
    if (!handled && !response.headersSent) {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
    }
  });
}
