import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActionRelayWebBridge } from "../src/web-bridge/action-relay-client.js";
import { PersonalBearerAuthenticator } from "../src/web-bridge/relay/auth.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { createRelayServer } from "../src/web-bridge/relay/server.js";
import { WEB_BRIDGE_PROTOCOL_VERSION } from "../src/web-bridge/contracts.js";

test("V04-UX-008 final-review relay is single-terminal while preserving exact replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-review-terminal-"));
  const token = "r".repeat(40);
  const store = new RelayFileStore(path.join(root, "relay"));
  const server = createRelayServer({ store, authenticator: new PersonalBearerAuthenticator([{ owner: "user", token }]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const relayUrl = `http://127.0.0.1:${address.port}`;
  const bridge = new ActionRelayWebBridge({ relayUrl, token: async () => token });

  try {
    const request = {
      run_id: `task:${"a".repeat(64)}`,
      result_bundle_sha256: "b".repeat(64),
      published_commit_sha: "c".repeat(40),
      pull_request_url: "https://github.com/example/repo/pull/42",
      review_round: 1,
    };
    const review = await bridge.createFinalReviewJob(request, "review-create");
    const verdict = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, review_id: review.job_id, run_id: request.run_id, result_bundle_sha256: request.result_bundle_sha256, verdict: "APPROVE", summary: "approved", findings: [] };
    const submit = async (key: string, body: unknown = verdict) => await fetch(`${relayUrl}/v1/final-reviews/${review.job_id}/verdict`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    assert.equal((await submit("verdict-one")).status, 201);
    assert.equal((await submit("verdict-one")).status, 201);
    assert.equal((await store.events(review.job_id, "user", 0)).filter((event) => event.type === "web_verdict").length, 1);
    const conflictingTerminal = await submit("verdict-two"); assert.equal(conflictingTerminal.status, 400); assert.match(await conflictingTerminal.text(), /terminal verdict/);
    assert.equal((await bridge.getConnectionStatus()).pending_final_review, undefined);
    const second = await bridge.createFinalReviewJob({ ...request, review_round: 2 }, "review-create-two");
    const wrongBinding = await fetch(`${relayUrl}/v1/final-reviews/${second.job_id}/verdict`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "wrong-binding" }, body: JSON.stringify({ ...verdict, review_id: second.job_id }) });
    assert.equal(wrongBinding.status, 400); assert.match(await wrongBinding.text(), /binding/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
