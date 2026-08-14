import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInboxIndex, writeInboxIndex } from "../src/inbox/inbox-index.js";
import { scanInbox } from "../src/inbox/scanner.js";

test("inbox index drops entries for candidates that no longer exist", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-inbox-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const inbox = path.join(root, "inbox");
  await mkdir(state, { recursive: true });
  await mkdir(inbox, { recursive: true });

  const stalePath = path.join(inbox, "wco-task-old.zip");
  await writeInboxIndex(state, {
    index_version: "1.0",
    entries: {
      [stalePath]: {
        canonical_source_path: stalePath,
        size: 123,
        mtime_ms: 1,
        latest_result: "rejected",
        last_processed_time: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  const summary = await scanInbox({
    inboxDirectory: inbox,
    stateDirectory: state,
    configPath: path.join(root, "unused-config.json"),
    config: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 100 },
    sleep: async () => undefined,
  });
  assert.equal(summary.discovered, 0);
  assert.deepEqual((await readInboxIndex(state)).entries, {});
});
