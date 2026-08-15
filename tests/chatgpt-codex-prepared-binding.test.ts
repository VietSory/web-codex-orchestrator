import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, contentDigest } from "../src/web-bridge/contracts.js";

test("chatgpt_codex prepared run binding is derived from the sealed contract and immutable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-chatgpt-prepared-bind-"));
  const bridge = new ChatGptCodexWebBridge({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { repo: { path: root, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
  } as any, path.join(root, "state", "bridge"));

  const identity = await bridge.createAuthoringJob({
    owner: "local",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 86_400,
    orchestration_mode: "AUTOPILOT",
  }, "create-job");

  const envelope: any = {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    job_id: identity.job_id,
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    title: "Change app",
    goal: "Change app safely",
    non_goals: ["No unrelated changes"],
    architecture_decisions: ["Keep current architecture"],
    allowed_paths: ["app.txt"],
    forbidden_paths: [".git/**"],
    acceptance_criteria: [{ id: "AC-001", description: "app is changed" }],
    verification_commands: [{ id: "test", executable: "npm", args: ["test"] }],
    risk_policy: { network_access: false, secrets_required: false, notes: [] },
    delivery: { remote: "origin", base_branch: "main", branch_name: "codex/change-app", draft: true, auto_merge: false },
    sources: [],
    implementation_strategy: ["Update app.txt"],
    project_map_hints: ["app.txt"],
  };

  const store = (bridge as any).store;
  await store.append(identity.job_id, "local-chatgpt-codex", "contract_sealed", { envelope }, "seal-contract");

  const taskId = `TASK-${contentDigest(envelope).slice(0, 32).toUpperCase()}`;
  const runA = `${taskId}:${"1".repeat(64)}`;
  const runB = `${taskId}:${"2".repeat(64)}`;

  await bridge.bindPreparedRun(identity.job_id, runA, "bind-a");
  await bridge.bindPreparedRun(identity.job_id, runA, "bind-a-replay-with-different-key");
  await assert.rejects(
    bridge.bindPreparedRun(identity.job_id, runB, "bind-b"),
    /already bound to a different canonical prepared run/i,
  );
  await assert.rejects(
    bridge.bindPreparedRun(identity.job_id, `TASK-WRONG:${"3".repeat(64)}`, "bind-wrong-task"),
    /does not derive from the exact sealed contract/i,
  );

  const preparedEvents = (await store.events(identity.job_id, "local-chatgpt-codex", 0)).filter((event: any) => event.type === "chatgpt_codex_prepared_run");
  assert.equal(preparedEvents.length, 1);
  assert.equal(preparedEvents[0].payload.run_id, runA);
});
