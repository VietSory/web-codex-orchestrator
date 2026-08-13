import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { productionDoctorProbes, type ControlArgs } from "../src/orchestration/control-cli.js";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { writeNativeOpenAiCredential } from "../src/web-bridge/native-openai-credential.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-native-doctor-"));
  const oldHome = process.env.WCO_HOME;
  process.env.WCO_HOME = root;
  const repo = path.join(root, "repo"), state = path.join(root, "state"), config = path.join(root, "config.json");
  await Promise.all([mkdir(repo), mkdir(state)]);
  await writeTrustedConfigAtomic(config, {
    config_version: "1.0",
    inbox: { poll_interval_ms: 2_000, stable_age_ms: 3_000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: { repo: { path: repo, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    web_bridge: { mode: "web_native_mcp", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 },
  } as any);
  await writeNativeOpenAiCredential(path.join(root, "credentials"), {
    schema_version: "1.0",
    tunnel_id: `tunnel_${"a".repeat(32)}`,
    control_plane_api_key: `sk-${"b".repeat(40)}`,
    workspace_agent_trigger_id: "agtch_native_doctor_fixture",
    workspace_agent_access_token: `wsa_${"c".repeat(40)}`,
  });
  return { root, state, config, restore: () => { if (oldHome === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = oldHome; } };
}

function args(stateDirectory: string, configPath: string, doctorMode: "PAIR" | "AUTOPILOT"): ControlArgs {
  return { stateDirectory, configPath, json: false, doctorMode, maxTransitions: 8 };
}

test("PAIR advanced-native Doctor skips Codex, third-party relay and managed device/account requirements", async () => {
  const item = await fixture();
  try {
    const probes = productionDoctorProbes(args(item.state, item.config, "PAIR"));
    const ids = probes.map((probe) => probe.id);
    assert.equal(ids.includes("codex-runtime"), false);
    assert.equal(ids.includes("codex-auth"), false);
    for (const id of ["wco-relay-service", "wco-device-account", "chatgpt-web", "senior-architect-gpt"]) {
      const probe = probes.find((candidate) => candidate.id === id);
      assert.ok(probe, `missing ${id}`);
      const result = await probe.run();
      assert.equal(result.severity, "OK", `${id}: ${result.summary}`);
      if (id === "wco-relay-service") assert.match(result.summary, /no third-party relay required/i);
      if (id === "wco-device-account") assert.match(result.summary, /no managed device\/account requirement/i);
    }
  } finally { item.restore(); }
});

test("AUTOPILOT advanced-native Doctor adds only reviewer runtime/auth probes on top of native Web probes", async () => {
  const item = await fixture();
  try {
    const ids = productionDoctorProbes(args(item.state, item.config, "AUTOPILOT")).map((probe) => probe.id);
    assert.ok(ids.includes("codex-runtime"));
    assert.ok(ids.includes("codex-auth"));
    assert.ok(ids.includes("wco-relay-service"));
    assert.ok(ids.includes("wco-device-account"));
  } finally { item.restore(); }
});