import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
