import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedServiceRuntime } from "../src/web-bridge/managed-service-runtime.js";
import { createManagedControlPlaneServer } from "../src/web-bridge/managed-service-server.js";
import { ManagedPairingRegistry } from "../src/web-bridge/relay/managed-pairing.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

async function listen(server: ReturnType<typeof createManagedControlPlaneServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function credential(pairing: ManagedPairingRegistry, accountId = "account-a") {
  const deviceId = "device-a", nonce = crypto.randomBytes(32).toString("base64url"), verifier = crypto.randomBytes(32).toString("base64url"), challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const pending = pairing.register({ device_id: deviceId, client_nonce: nonce, code_challenge: challenge, scopes: ["wco.relay"], ttl_seconds: 600 });
  pairing.authorize(pending.registration_id, accountId);
  return pairing.exchange({ registration_id: pending.registration_id, device_code: pending.device_code, device_id: deviceId, client_nonce: nonce, code_verifier: verifier });
}

function runtimeFixture(root: string) {
  const pairing = new ManagedPairingRegistry();
  const store = new RelayFileStore(path.join(root, "relay"));
  const triggers: any[] = [];
  const gateway = {
    ready: async () => true,
    trigger: async (input: any) => { triggers.push(input); return { agent_trigger_run_id: `apirun_${triggers.length}`, conversation_url: "https://chatgpt.com/c/managed-test" }; },
    status: async (accountId: string, runId: string) => ({ id: runId, status: "in_progress" as const, conversation_url: "https://chatgpt.com/c/managed-test", error: null, accountId }),
  };
  const runtime = new ManagedServiceRuntime({
    pairing,
    relayStore: store,
    publicOrigin: "https://wco.example.test/",
    readiness: async () => ({ chatgpt_oauth_configured: true, senior_architect_gpt_configured: true }),
    accountAuthorization: { authenticate: async () => ({ kind: "authenticated" as const, account_id: "account-a" }) },
    agentGateway: gateway,
  });
  return { pairing, store, triggers, runtime };
}

test("managed runtime registration returns one service-owned HTTPS verification URL and no provider credential fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-runtime-register-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = runtimeFixture(root), server = createManagedControlPlaneServer(fixture.runtime); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = await listen(server), nonce = crypto.randomBytes(32).toString("base64url"), verifier = crypto.randomBytes(32).toString("base64url"), challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const response = await fetch(`${origin}/v1/managed/device/registrations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocol_version: "wco-web-bridge-v1", device_id: "device-a", client_nonce: nonce, code_challenge: challenge, code_challenge_method: "S256", scopes: ["wco.relay"] }) });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  assert.match(body.verification_uri_complete, /^https:\/\/wco\.example\.test\/v1\/managed\/device\/authorize\?registration_id=/);
  assert.deepEqual(Object.keys(body).sort(), ["device_code", "expires_in", "interval", "registration_id", "verification_uri_complete"]);
  assert.doesNotMatch(JSON.stringify(body), /api[_ -]?key|tunnel|workspace.agent.*token|relay_url|gpt_url/i);
});

test("managed final-intent trigger resolves exact original Web-A instead of latest author conversation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-runtime-author-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = runtimeFixture(root), account = "account-a", issued = credential(fixture.pairing, account);
  const repo = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) };
  const first = await fixture.store.create("authoring", account, { owner: account, repository: repo, user_intent: "first", ttl_seconds: 600 }, "author-one", 600);
  const second = await fixture.store.create("authoring", account, { owner: account, repository: repo, user_intent: "second", ttl_seconds: 600 }, "author-two", 600);
  const runOne = `task-one:${"1".repeat(64)}`, runTwo = `task-two:${"2".repeat(64)}`;
  await fixture.store.append(first.job_id, account, "implementation_sealed", { submission: { run_id: runOne } }, "impl-one");
  await fixture.store.append(second.job_id, account, "implementation_sealed", { submission: { run_id: runTwo } }, "impl-two");
  const review = await fixture.store.create("final_review", account, { run_id: runOne, result_bundle_sha256: "3".repeat(64), published_commit_sha: "4".repeat(40), pull_request_url: "https://github.com/example/repo/pull/1", review_round: 1 }, "final-one", 600);

  const server = createManagedControlPlaneServer(fixture.runtime); t.after(() => new Promise<void>((resolve) => server.close(() => resolve()))); const origin = await listen(server);
  const response = await fetch(`${origin}/v1/managed/agent/trigger`, { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json", "Idempotency-Key": "final-trigger" }, body: JSON.stringify({ purpose: "final_intent_review", identity: review.job_id, input: "Review exact final result" }) });
  assert.equal(response.status, 202, await response.text());
  assert.equal(fixture.triggers.length, 1);
  assert.equal(fixture.triggers[0].conversation_key, `wco-author-${account}-${first.job_id}`);
  assert.notEqual(fixture.triggers[0].conversation_key, `wco-author-${account}-${second.job_id}`);
});

test("independent Web-B receives a distinct deterministic conversation key", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-runtime-review-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = runtimeFixture(root), account = "account-a", issued = credential(fixture.pairing, account);
  const review = await fixture.store.create("final_review", account, { run_id: `task:${"5".repeat(64)}`, result_bundle_sha256: "6".repeat(64), published_commit_sha: "7".repeat(40), pull_request_url: "https://github.com/example/repo/pull/2", review_round: 1 }, "review-independent", 600);
  const server = createManagedControlPlaneServer(fixture.runtime); t.after(() => new Promise<void>((resolve) => server.close(() => resolve()))); const origin = await listen(server);
  const response = await fetch(`${origin}/v1/managed/agent/trigger`, { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json", "Idempotency-Key": "review-trigger" }, body: JSON.stringify({ purpose: "independent_code_review", identity: review.job_id, input: "Review independently" }) });
  assert.equal(response.status, 202, await response.text());
  assert.equal(fixture.triggers[0].conversation_key, `wco-review-${account}-${review.job_id}`);
  assert.doesNotMatch(fixture.triggers[0].conversation_key, /^wco-author-/);
});
