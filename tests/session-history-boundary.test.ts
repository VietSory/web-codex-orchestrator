import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listLocalTaskHistory } from "../src/web-bridge/session-history.js";

test("history listing refuses a symlinked history directory instead of reading outside state", async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "wco-history-boundary-state-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-history-boundary-outside-"));
  t.after(async () => {
    await rm(state, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(path.join(state, "bridge", "sessions"), { recursive: true });
  await symlink(outside, path.join(state, "bridge", "sessions", "history"), "dir");

  await assert.rejects(listLocalTaskHistory(state, "repo"), /unsafe directory component|session history/i);
  assert.deepEqual(await readdir(outside), []);
});
