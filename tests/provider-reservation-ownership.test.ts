import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

const OWNER = "local-chatgpt-codex";
const request = {
  owner: "local",
  repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
  user_intent: "change app",
  ttl_seconds: 60,
  orchestration_mode: "PAIR" as const,
};

test("exact provider reservation has one durable owner across independent store instances", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstStore = new RelayFileStore(root);
  const secondStore = new RelayFileStore(root);
  const identity = await firstStore.create("authoring", OWNER, request, "create-author", 60);
  const payload = { input_sha256: "b".repeat(64), thread_id: null };

  const [first, second] = await Promise.all([
    firstStore.claim(identity.job_id, OWNER, "chatgpt_codex_authoring_reserved", payload, "author-reserve-exact", "00000000-0000-4000-8000-000000000001"),
    secondStore.claim(identity.job_id, OWNER, "chatgpt_codex_authoring_reserved", payload, "author-reserve-exact", "00000000-0000-4000-8000-000000000002"),
  ]);

  assert.equal(Number(first.acquired) + Number(second.acquired), 1);
  assert.equal(first.event.sequence, second.event.sequence);
  const events = await firstStore.events(identity.job_id, OWNER, 0);
  assert.equal(events.filter((event) => event.type === "chatgpt_codex_authoring_reserved").length, 1);
  const winnerNonce = ((first.acquired ? first.event : second.event).payload as { claim_nonce: string }).claim_nonce;
  const replay = await secondStore.claim(identity.job_id, OWNER, "chatgpt_codex_authoring_reserved", payload, "author-reserve-exact", winnerNonce);
  assert.equal(replay.acquired, false, "a durable provider claim can never be reacquired, even by replaying the original nonce");
});

test("provider claim replay cannot silently retarget the reserved input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-provider-claim-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RelayFileStore(root);
  const identity = await store.create("authoring", OWNER, request, "create-author", 60);
  await store.claim(identity.job_id, OWNER, "chatgpt_codex_authoring_reserved", { input_sha256: "b".repeat(64) }, "author-reserve-exact", "00000000-0000-4000-8000-000000000001");
  await assert.rejects(
    store.claim(identity.job_id, OWNER, "chatgpt_codex_authoring_reserved", { input_sha256: "c".repeat(64) }, "author-reserve-exact", "00000000-0000-4000-8000-000000000002"),
    (error: any) => error?.code === "RELAY_IDEMPOTENCY_CONFLICT",
  );
});

test("production ChatGPT/Codex bridge binds author, implementation, and review reservations to claim ownership", async () => {
  const source = await readFile(new URL("../src/web-bridge/chatgpt-codex-bridge.ts", import.meta.url), "utf8");
  assert.match(source, /store\.claim\(jobId, OWNER, "chatgpt_codex_authoring_reserved"/);
  assert.match(source, /store\.claim\(jobId, OWNER, "chatgpt_codex_implementation_reserved"/);
  assert.match(source, /store\.claim\(reviewId, OWNER, "chatgpt_codex_review_reserved"/);
  assert.match(source, /if \(!claim\.acquired\) throw providerBusy\(\)/);
});
