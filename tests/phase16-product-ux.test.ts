import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigError, loadTrustedConfig, MAXIMUM_TRUSTED_CONFIG_BYTES } from "../src/config/config-loader.js";
import { TRUSTED_CONFIG_HARD_LIMITS, validateConfig } from "../src/config/config-validator.js";
import { parseControlArgs } from "../src/orchestration/control-cli.js";
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
  await fs.writeFile(path.join(inbox, "wco-task-a.zip"), "a");
  await fs.writeFile(path.join(inbox, "wco-task-b.zip"), "b");
  return { root, inbox, state };
}

function validTrustedConfig(): Record<string, unknown> {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 2_000, stable_age_ms: 3_000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: { repo: { path: path.resolve("repo"), remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: {
        maximum_implementation_iterations: 8,
        maximum_internal_review_rounds: 4,
        maximum_sol_review_rounds: 3,
        maximum_total_agent_turns: 18,
        maximum_turn_seconds: 1_800,
        maximum_total_seconds: 7_200,
        maximum_total_input_tokens: 2_000_000,
        maximum_total_output_tokens: 300_000,
      },
    },
    verification: { allowed_executables: ["node", "npm", "git"], allowed_environment_keys: ["CI"], maximum_command_seconds: 1_800, maximum_output_bytes: 4_194_304, allowed_generated_paths: ["dist/**"] },
  };
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

test("P16-PRODUCT-004 trusted config reads are allocation-bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-config-bound-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, Buffer.alloc(MAXIMUM_TRUSTED_CONFIG_BYTES + 1, 0x20));
  await assert.rejects(
    loadTrustedConfig(configPath),
    (error: unknown) => error instanceof ConfigError && error.code === "CONFIG_INVALID" && /safety limit/.test(error.message),
  );
});

test("P16-PRODUCT-005 doctor is a machine preflight and does not require an existing run id", () => {
  const parsed = parseControlArgs("doctor", ["--state-dir", "./state", "--config", "./config.json"]);
  assert.equal(parsed.runId, undefined);
  assert.equal(parsed.json, false);
  assert.equal(parsed.maxTransitions, 8);
});

test("P16-PRODUCT-006 trusted config cannot accidentally grant unbounded resource or token budgets", () => {
  const baseline = validTrustedConfig();
  assert.equal(validateConfig(baseline).ok, true);

  const tokenHeavy = structuredClone(baseline) as any;
  tokenHeavy.agents.limits.maximum_total_input_tokens = TRUSTED_CONFIG_HARD_LIMITS.agents.maximum_total_input_tokens + 1;
  assert.equal(validateConfig(tokenHeavy).ok, false);

  const inboxHeavy = structuredClone(baseline) as any;
  inboxHeavy.inbox.maximum_candidates_per_scan = TRUSTED_CONFIG_HARD_LIMITS.inbox.maximum_candidates_per_scan + 1;
  assert.equal(validateConfig(inboxHeavy).ok, false);

  const archiveHeavy = structuredClone(baseline) as any;
  archiveHeavy.result_bundle = { maximum_archive_bytes: TRUSTED_CONFIG_HARD_LIMITS.result_bundle.maximum_archive_bytes + 1 };
  assert.equal(validateConfig(archiveHeavy).ok, false);
});

test("P16-PRODUCT-007 local final checklist references only real npm scripts", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  const checklist = await fs.readFile(path.resolve("LOCAL-FINAL-CHECKLIST.md"), "utf8");
  const referenced = [...checklist.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]!);
  assert.ok(referenced.length > 0);
  for (const script of referenced) assert.ok(script in scripts, `LOCAL-FINAL-CHECKLIST references missing npm script '${script}'`);
  assert.match(checklist, /npm run test:native:sandbox/);
  assert.match(checklist, /npm run test:native:codex/);
});
