import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedRelayAuthenticator } from "../src/web-bridge/managed-service-server.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { ManagedPairingRegistry } from "../src/web-bridge/relay/managed-pairing.js";
import { createRelayServer } from "../src/web-bridge/relay/server.js";

function issue(pairing: ManagedPairingRegistry) {
  const verifier = crypto.randomBytes(32).toString("base64url"), nonce = crypto.randomBytes(32).toString("base64url"), challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const pending = pairing.register({ device_id: "device-a", client_nonce: nonce, code_challenge: challenge, scopes: ["wco.relay"] });
  pairing.authorize(pending.registration_id, "account-a");
  return pairing.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: "device-a", client_nonce: nonce, code_verifier: verifier });
}

test("managed scoped device access token is sufficient for bounded relay routes and no provider token is involved", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-relay-auth-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pairing = new ManagedPairingRegistry(), issued = issue(pairing);
  const server = createRelayServer({ store: new RelayFileStore(path.join(root, "relay")), authenticator: new ManagedRelayAuthenticator(pairing) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/status`, { headers: { Authorization: `Bearer ${issued.access_token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.account, "account-a");
  assert.equal(body.connected, true);
});
