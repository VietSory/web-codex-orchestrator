import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

test("durable bridge store rejects event digest/idempotency corruption", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RelayFileStore(root);
  const identity = await store.create("authoring", "owner", {
    owner: "owner",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 86_400,
  }, "create-1", 86_400);
  await store.append(identity.job_id, "owner", "repository_command", { request_id: "read-1", command: { operation: "summary" } }, "event-1");

  const target = path.join(root, `${identity.job_id}.json`);
  const record = JSON.parse(await readFile(target, "utf8"));
  record.events[0].payload = { request_id: "read-1", command: { operation: "tree" } };
  await writeFile(target, JSON.stringify(record));
  await assert.rejects(store.get(identity.job_id, "owner"), /digest or idempotency index is inconsistent/i);
});

test("durable bridge store rejects symlink record substitution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-symlink-"));
  const outside = path.join(root, "outside.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RelayFileStore(root);
  const identity = await store.create("authoring", "owner", {
    owner: "owner",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 86_400,
  }, "create-2", 86_400);
  const target = path.join(root, `${identity.job_id}.json`);
  const original = await readFile(target);
  await writeFile(outside, original);
  await rm(target);
  await symlink(outside, target);
  await assert.rejects(store.get(identity.job_id, "owner"), /path is unsafe|could not be opened safely/i);
});

test("durable bridge store prunes expired records before capacity blocks a new session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new RelayFileStore(root, { maximum_record_files: 2 }, () => now);
  const request = {
    owner: "owner",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 60,
  };

  await store.create("authoring", "owner", request, "session-1", 60);
  await store.create("authoring", "owner", request, "session-2", 60);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".json")).length, 2);

  now = new Date("2026-01-01T00:02:00.000Z");
  const fresh = await store.create("authoring", "owner", request, "session-3", 60);
  const records = (await readdir(root)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(records, [`${fresh.job_id}.json`]);
});

test("separate relay store instances serialize concurrent mutations without lost events", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new RelayFileStore(root);
  const second = new RelayFileStore(root);
  const request = {
    owner: "owner",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 86_400,
  };
  const identity = await first.create("authoring", "owner", request, "concurrent-create", 86_400);

  const count = 24;
  await Promise.all(Array.from({ length: count }, (_, index) => {
    const store = index % 2 === 0 ? first : second;
    return store.append(identity.job_id, "owner", "user_clarification", { index }, `concurrent-event-${index}`);
  }));

  const record = await first.get(identity.job_id, "owner");
  assert.equal(record.events.length, count);
  assert.deepEqual(record.events.map((event) => event.sequence), Array.from({ length: count }, (_, index) => index + 1));
  assert.deepEqual(new Set(record.events.map((event) => (event.payload as { index: number }).index)).size, count);
  assert.equal((await readdir(path.join(root, ".writer-locks"))).length, 0, "successful mutations leave no writer tickets behind");
});
