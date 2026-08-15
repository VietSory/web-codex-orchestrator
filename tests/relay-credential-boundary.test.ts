import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRelayToken, writeRelayToken } from "../src/web-bridge/relay-credential.js";

test("maximum valid 4096-character relay credential round-trips through its newline-terminated file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-token-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "x".repeat(4096);
  await writeRelayToken(root, token);
  assert.equal(await readRelayToken(root, {}), token);
});
