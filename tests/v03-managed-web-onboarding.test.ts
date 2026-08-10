import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { loadTrustedConfig } from "../src/config/config-loader.js";
import { validateManagedWebServiceMetadata } from "../src/web-bridge/managed-service.js";
import { configureManagedWebBridgeConnection } from "../src/web-bridge/connection-setup.js";
import { ManagedWebOnboardingClient } from "../src/web-bridge/managed-onboarding.js";
import { managedCredentialPath, readManagedDeviceCredential } from "../src/web-bridge/managed-credential.js";
import { ManagedPairingRegistry } from "../src/web-bridge/relay/managed-pairing.js";
import { createRelayServer } from "../src/web-bridge/relay/server.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { PersonalBearerAuthenticator } from "../src/web-bridge/relay/auth.js";

const metadata = validateManagedWebServiceMetadata({ schema_version: "1.0", deployment_status: "test", protocol_version: "wco-web-bridge-v1", relay_url: "http://127.0.0.1:8787", gpt_url: "https://chatgpt.com/g/wco-senior-architect" }, { allowLoopback: true });

function config(repo: string): any {
  return { config_version: "1.0", inbox: { poll_interval_ms: 1_000, stable_age_ms: 1_000, stable_observations: 2, maximum_candidates_per_scan: 100 }, repositories: { repo: { path: repo, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } }, web_bridge: { mode: "managed_actions", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 } };
}

function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }

function managedFetcher(options: { expiresIn?: number; refreshStatus?: number } = {}): { fetchImpl: typeof fetch; registrations: any[]; refreshes: any[]; revokes: any[] } {
  const registrations: any[] = [], refreshes: any[] = [], revokes: any[] = [];
  let deviceId = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/managed/service/status") return json({ protocol_version: "wco-web-bridge-v1", available: true, chatgpt_oauth_configured: true, senior_architect_gpt_configured: true });
    if (url.pathname === "/v1/managed/device/registrations") { registrations.push(body); deviceId = body.device_id; return json({ registration_id: "registration-1", device_code: "device-code-1", verification_uri_complete: "https://auth.example.test/wco", expires_in: 600, interval: 1 }, 201); }
    if (url.pathname === "/v1/managed/device/token") return json({ token_type: "Bearer", access_token: "a".repeat(40), refresh_token: "r".repeat(40), expires_in: options.expiresIn ?? 3_600, account_id: "account-a", device_id: deviceId, scope: "wco.relay" });
    if (url.pathname === "/v1/managed/token/refresh") { refreshes.push(body); if (options.refreshStatus && options.refreshStatus !== 200) return json({ error: "invalid_grant" }, options.refreshStatus); return json({ token_type: "Bearer", access_token: "b".repeat(40), refresh_token: "s".repeat(40), expires_in: 3_600, account_id: "account-a", device_id: body.device_id, scope: "wco.relay" }); }
    if (url.pathname === "/v1/managed/device/revoke") { revokes.push(body); return json({ revoked: true }); }
    if (url.pathname === "/v1/status") return json({ configured: true, connected: init?.headers instanceof Headers ? init.headers.has("Authorization") : true });
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, registrations, refreshes, revokes };
}

test("managed metadata is secret-free, clean HTTPS, fixed, and test overrides are explicit", async () => {
  const source = await readFile(new URL("../web/managed-service.json", import.meta.url), "utf8");
  assert.doesNotMatch(source, /token|secret|bearer|credential/i);
  assert.deepEqual(Object.keys(JSON.parse(source)).sort(), ["deployment_status", "gpt_url", "protocol_version", "relay_url", "schema_version"]);
  const valid = validateManagedWebServiceMetadata({ schema_version: "1.0", deployment_status: "available", protocol_version: "wco-web-bridge-v1", relay_url: "https://relay.example.test", gpt_url: "https://chatgpt.com/g/fixed-wco" });
  assert.equal(valid.relay_url, "https://relay.example.test");
  assert.equal(valid.gpt_url, "https://chatgpt.com/g/fixed-wco");
  for (const relay_url of ["http://relay.example.test", "https://user@relay.example.test", "https://relay.example.test/#fragment", "https://relay.example.test/path"]) {
    assert.throws(() => validateManagedWebServiceMetadata({ schema_version: "1.0", deployment_status: "available", protocol_version: "wco-web-bridge-v1", relay_url, gpt_url: "https://chatgpt.com/g/fixed-wco" }), /METADATA_INVALID|clean HTTPS/);
  }
});

test("managed GPT schema uses scoped OAuth and exposes only bounded WCO transport actions", async () => {
  const schema = await readFile(new URL("../web/gpt/openapi.yaml", import.meta.url), "utf8");
  assert.match(schema, /type: oauth2/); assert.match(schema, /authorizationCode:/); assert.match(schema, /wco\.action/);
  assert.doesNotMatch(schema, /bearerAuth|scheme:\s*bearer|shell|executeCommand|github/i);
  for (const operation of ["getPendingTask", "getRepositorySummary", "listRepositoryTree", "searchRepository", "readRepositoryFiles", "getRepositoryCommandResult", "submitAuthoringEvent", "getPendingReview", "readResultEvidence", "submitWebVerdict"]) assert.match(schema, new RegExp(`operationId: ${operation}`));
  assert.match(schema, /deployment-required\.invalid/);
});

test("managed first connection stores only a protected scoped device credential and fixed URLs never enter config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-connect-")), repo = path.join(root, "repo"), home = path.join(root, "home");
  await mkdir(repo); await writeTrustedConfigAtomic(path.join(home, "config.json"), config(repo));
  const fixture = managedFetcher(), opened: string[] = [];
  const connected = await configureManagedWebBridgeConnection({ configPath: path.join(home, "config.json"), credentialsDirectory: path.join(home, "credentials"), metadata, fetchImpl: fixture.fetchImpl, openAuthorization: async (url) => { opened.push(url); return opened.length === 1; } });
  assert.equal(connected.status.connected, true);
  assert.equal(connected.gpt_opened, false);
  assert.deepEqual(opened, ["https://auth.example.test/wco", metadata.gpt_url]);
  assert.equal(fixture.registrations.length, 1);
  assert.equal(fixture.registrations[0].code_challenge_method, "S256");
  assert.ok(fixture.registrations[0].client_nonce.length >= 32);
  const saved = await loadTrustedConfig(path.join(home, "config.json"));
  assert.equal(saved.web_bridge?.mode, "managed_actions");
  assert.equal(saved.web_bridge?.relay_url, undefined); assert.equal(saved.web_bridge?.gpt_url, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /a{32}|r{32}|account-a/);
  const credential = await readManagedDeviceCredential(path.join(home, "credentials"));
  assert.equal(credential.account_id, "account-a"); assert.deepEqual(credential.scopes, ["wco.relay"]);
  if (process.platform !== "win32") assert.equal((await stat(managedCredentialPath(path.join(home, "credentials")))).mode & 0o777, 0o600);
});

test("returning credential refreshes silently, revoked refresh is removed and requires one safe reconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-refresh-")), credentials = path.join(root, "credentials");
  let now = new Date("2026-01-01T00:00:00.000Z");
  const initial = managedFetcher({ expiresIn: 60 });
  const client = new ManagedWebOnboardingClient({ metadata, credentialsDirectory: credentials, fetchImpl: initial.fetchImpl, now: () => now });
  await client.connect(async () => true);
  now = new Date("2026-01-01T00:01:00.000Z");
  assert.equal(await client.accessToken(), "b".repeat(40)); assert.equal(initial.refreshes.length, 1);
  const revokedFixture = managedFetcher({ refreshStatus: 401 });
  now = new Date("2026-01-01T01:02:00.000Z");
  const revoked = new ManagedWebOnboardingClient({ metadata, credentialsDirectory: credentials, fetchImpl: revokedFixture.fetchImpl, now: () => now });
  await assert.rejects(revoked.accessToken(), (error: any) => error?.code === "WEB_MANAGED_RECONNECT_REQUIRED");
  await assert.rejects(readManagedDeviceCredential(credentials), /RECONNECT_REQUIRED|not linked/);
});

test("managed pairing is expiring, PKCE/device bound, single use, refresh rotating, and account isolated", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const registry = new ManagedPairingRegistry(() => now), verifier = crypto.randomBytes(32).toString("base64url"), challenge = crypto.createHash("sha256").update(verifier).digest("base64url"), nonce = crypto.randomBytes(32).toString("base64url");
  const pending = registry.register({ device_id: "device-a", client_nonce: nonce, code_challenge: challenge, scopes: ["wco.relay"], ttl_seconds: 60 });
  assert.throws(() => registry.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: "device-a", client_nonce: nonce, code_verifier: verifier }), /PENDING|awaiting/);
  registry.authorize(pending.registration_id, "account-a");
  assert.throws(() => registry.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: "device-b", client_nonce: nonce, code_verifier: verifier }), /REJECTED|did not match/);
  const issued = registry.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: "device-a", client_nonce: nonce, code_verifier: verifier });
  assert.equal(issued.account_id, "account-a"); assert.equal(issued.device_id, "device-a");
  assert.deepEqual(registry.authenticate(issued.access_token, "wco.relay"), { account_id: "account-a", device_id: "device-a" });
  assert.throws(() => registry.authenticate(issued.access_token, "wco.action"), /UNAUTHORIZED|insufficiently scoped/);
  assert.throws(() => registry.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: "device-a", client_nonce: nonce, code_verifier: verifier }), /REPLAYED|already consumed/);
  const rotated = registry.refresh(issued.refresh_token, "device-a"); assert.equal(rotated.account_id, "account-a"); assert.notEqual(rotated.refresh_token, issued.refresh_token);
  assert.throws(() => registry.refresh(issued.refresh_token, "device-a"), /RECONNECT_REQUIRED|revoked/);
  registry.revoke(rotated.access_token, "device-a");
  assert.throws(() => registry.authenticate(rotated.access_token, "wco.relay"), /UNAUTHORIZED|invalid/);
  assert.throws(() => registry.refresh(rotated.refresh_token, "device-a"), /RECONNECT_REQUIRED|revoked/);
  const expired = registry.register({ device_id: "device-z", client_nonce: nonce, code_challenge: challenge, scopes: ["wco.relay"], ttl_seconds: 60 });
  now = new Date("2026-01-01T00:02:00.000Z");
  assert.throws(() => registry.authorize(expired.registration_id, "account-z"), /EXPIRED|expired/);
});

test("authenticated relay owner cannot spoof or fetch another managed account's task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-isolation-")), tokenA = "a".repeat(40), tokenB = "b".repeat(40), store = new RelayFileStore(root);
  const server = createRelayServer({ store, authenticator: new PersonalBearerAuthenticator([{ owner: "account-a", token: tokenA }, { owner: "account-b", token: tokenB }]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object"); const relay = `http://127.0.0.1:${address.port}`;
  try {
    const created = await fetch(`${relay}/v1/authoring/jobs`, { method: "POST", headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json", "Idempotency-Key": "create-a" }, body: JSON.stringify({ owner: "account-b", repository: { repository_id: "repo-a", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "A task", ttl_seconds: 600 }) });
    assert.equal(created.status, 201); const identity = await created.json() as any; assert.equal(identity.owner, "account-a");
    assert.equal(((await store.get(identity.job_id, "account-a")).request as any).owner, "account-a");
    const forbidden = await fetch(`${relay}/v1/jobs/${identity.job_id}/events`, { headers: { Authorization: `Bearer ${tokenB}` } }); assert.equal(forbidden.status, 403);
    const pendingB = await fetch(`${relay}/v1/authoring/pending`, { headers: { Authorization: `Bearer ${tokenB}` } }); assert.equal((await pendingB.json() as any).job, null);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
