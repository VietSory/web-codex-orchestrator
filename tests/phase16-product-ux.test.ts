import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanInbox } from "../src/inbox/scanner.js";
import { watchInbox } from "../src/inbox/watcher.js";

const INBOX_CONFIG = {
  poll_interval_ms: 2_000,
  stable_age_ms: 24 * 60 * 60 * 1_000,
  stable_observations: 2,
  maximum_candidates_per_scan: 100,
} as const;

async function createInboxFixture(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const inbox = path.join(root, "inbox");
  const state = path.join(root, "state");
  await fs.mkdir(inbox);
  await fs.writeFile(path.join(inbox, "a.zip"), "a");
  await fs.writeFile(path.join(inbox, "b.zip"), "b");
  return { root, inbox, state };
}

test("P16-PRODUCT-001 inbox candidates share one stability wait per observation round", async (t) => {
  const fixture = await createInboxFixture("wco-p16-inbox-batch-");
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  let sleeps = 0;
  const report = await scanInbox({
    inboxDirectory: fixture.inbox,
    stateDirectory: fixture.state,
    configPath: path.join(fixture.root, "unused-config.json"),
    config: { ...INBOX_CONFIG },
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(report.discovered, 2);
  assert.equal(report.unstable, 2);
  assert.equal(sleeps, 1, "stability waiting must be per round, not per candidate");
});

test("P16-PRODUCT-002 watch reuses stability observations between scans", async (t) => {
  const fixture = await createInboxFixture("wco-p16-inbox-watch-");
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  let sleeps = 0;
  let scans = 0;
  await watchInbox({
    inboxDirectory: fixture.inbox,
    stateDirectory: fixture.state,
    configPath: path.join(fixture.root, "unused-config.json"),
    config: { ...INBOX_CONFIG },
    maxIterations: 2,
    sleep: async () => { sleeps += 1; },
    onScan: async () => { scans += 1; },
  });
  assert.equal(scans, 2);
  assert.equal(sleeps, 2, "one stability wait plus one inter-scan wait is sufficient");
});

test("P16-PRODUCT-003 CI checks out and asserts the exact event head", async () => {
  const workflow = await fs.readFile(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /WCO_EXPECTED_SHA:/);
  assert.match(workflow, /ref: \$\{\{ env\.WCO_EXPECTED_SHA \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /git rev-parse HEAD/);
});
