import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedWebOnboardingClient } from "../src/web-bridge/managed-onboarding.js";
import { validateManagedWebServiceMetadata } from "../src/web-bridge/managed-service.js";
import { ManagedServiceRuntime } from "../src/web-bridge/managed-service-runtime.js";
import { createManagedWcoServiceServer } from "../src/web-bridge/managed-service-server.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { ManagedPairingRegistry } from "../src/web-bridge/relay/managed-pairing.js";

function gateway() {
  return {
    ready: async () => true,
    trigger: async () => ({ agent_trigger_run_id: "apirun_fixture", conversation_url: "https://chatgpt.com/c/fixture" }),
    status: async (_account: string, runId: string) => ({ id: runId, status: "in_progress" as const, conversation_url: "https://chatgpt.com/c/fixture", error: null }),
  };
}

test("normal managed client completes with exactly one browser URL and then authenticates bounded relay on the same service origin", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-one-link-e2e-")); t.after(() => rm(root, { recursive: true, force: true }));
  const pairing = new ManagedPairingRegistry(), relayStore = new RelayFileStore(path.join(root, "relay"));
  const runtime = new ManagedServiceRuntime({
    pairing,
    relayStore,
    publicOrigin: "https://wco.example.test/",
    readiness: async () => ({ chatgpt_oauth_configured: true, senior_architect_gpt_configured: true }),
    accountAuthorization: { authenticate: async () => ({ kind: "authenticated" as const, account_id: "account-a" }) },
    agentGateway: gateway(),
  });
  const server = createManagedWcoServiceServer({ runtime, relayStore, pairing });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object"); const localOrigin = `http://127.0.0.1:${address.port}`;
  const metadata = validateManagedWebServiceMetadata({ schema_version: "1.0", deployment_status: "test", protocol_version: "wco-web-bridge-v1", relay_url: localOrigin, gpt_url: "https://chatgpt.com/g/wco" }, { allowLoopback: true });
  const opened: string[] = [];
  const client = new ManagedWebOnboardingClient({ metadata, credentialsDirectory: path.join(root, "credentials"), sleep: async () => undefined });

  const result = await client.connect(async (url) => {
    opened.push(url);
    const external = new URL(url);
    const local = new URL(`${external.pathname}${external.search}`, localOrigin);
    const authorized = await fetch(local);
    assert.equal(authorized.status, 200, await authorized.text());
    return true;
  });

  assert.equal(opened.length, 1, "normal user must see exactly one browser authorization URL");
  assert.match(opened[0]!, /^https:\/\/wco\.example\.test\/v1\/managed\/device\/authorize\?/);
  assert.equal(result.status.connected, true);
  assert.equal(result.credential.account_id, "account-a");
  assert.equal(result.gpt_opened, false, "managed connect must never open a second GPT/browser URL");
  assert.equal(await client.accessToken(), result.credential.access_token, "returning use reuses the stored scoped credential without another browser step");
});
