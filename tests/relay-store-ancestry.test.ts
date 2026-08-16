import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";

const request = {
  owner: "owner",
  repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
  user_intent: "change app",
  ttl_seconds: 86_400,
};

test("relay store rejects symlinked parent ancestry before creating any outside-state path", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "wco-relay-ancestry-"));
  const outside = path.join(sandbox, "outside");
  const redirectedParent = path.join(sandbox, "bridge");
  const relayRoot = path.join(redirectedParent, "relay");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await mkdir(outside);
  await symlink(outside, redirectedParent, "dir");

  const store = new RelayFileStore(relayRoot);
  await assert.rejects(
    store.create("authoring", "owner", request, "unsafe-parent", 86_400),
    /relay store parent.*not canonical/i,
  );
  assert.deepEqual(await readdir(outside), [], "unsafe ancestry must not create relay or writer-lock paths outside managed state");
});
