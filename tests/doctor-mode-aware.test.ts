import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseControlArgs, productionDoctorProbes } from "../src/orchestration/control-cli.js";
import { runDoctor } from "../src/orchestration/doctor.js";

function doctorArgs(mode?: "PAIR" | "AUTOPILOT") {
  return parseControlArgs("doctor", [
    "--state-dir", "/tmp/wco-doctor-state",
    "--config", "/tmp/wco-doctor-config.json",
    ...(mode ? ["--mode", mode] : []),
  ]);
}

test("doctor mode parsing defaults to PAIR and preserves explicit AUTOPILOT", () => {
  assert.equal(doctorArgs().doctorMode, "PAIR");
  assert.equal(doctorArgs("PAIR").doctorMode, "PAIR");
  assert.equal(doctorArgs("AUTOPILOT").doctorMode, "AUTOPILOT");
});

test("doctor rejects invalid modes and mode outside doctor", () => {
  assert.throws(
    () => parseControlArgs("doctor", [
      "--state-dir", "/tmp/wco-doctor-state",
      "--config", "/tmp/wco-doctor-config.json",
      "--mode", "INVALID",
    ]),
    /--mode must be PAIR or AUTOPILOT/,
  );
  assert.throws(
    () => parseControlArgs("status", [
      "--run-id", `task:${"a".repeat(64)}`,
      "--state-dir", "/tmp/wco-doctor-state",
      "--mode", "AUTOPILOT",
    ]),
    /--mode is valid only for doctor/,
  );
});

test("zero-config PAIR Doctor uses the local ChatGPT/Codex transport and never asks for hosted Web infrastructure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-doctor-local-pair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: { repo: { path: root, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    runtime: { source: "bundled" },
  }));
  const args = parseControlArgs("doctor", ["--state-dir", path.join(root, "state"), "--config", configPath, "--mode", "PAIR"]);
  const probes = productionDoctorProbes(args);

  const runtime = probes.find((probe) => probe.id === "codex-runtime");
  const auth = probes.find((probe) => probe.id === "codex-auth");
  assert.ok(runtime, "local PAIR must include the pinned Codex runtime readiness check");
  assert.ok(auth, "local PAIR must include ChatGPT authorization readiness");
  assert.doesNotMatch((await runtime.run()).summary, /does not require/i);

  for (const [id, pattern] of [
    ["wco-relay-service", /no relay or hosted service required/i],
    ["wco-device-account", /no managed device\/account requirement/i],
    ["senior-architect-gpt", /no Custom GPT or Workspace Agent requirement/i],
  ] as const) {
    const probe = probes.find((candidate) => candidate.id === id);
    assert.ok(probe, `missing ${id}`);
    const result = await probe.run();
    assert.equal(result.severity, "OK", `${id}: ${result.summary}`);
    assert.match(result.summary, pattern);
  }
});

test("AUTOPILOT doctor reports unavailable runtime and managed service without an unhandled rejection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-doctor-lazy-probes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: { repo: { path: root, remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } },
    web_bridge: { mode: "managed_actions", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 },
  }));
  const args = parseControlArgs("doctor", ["--state-dir", path.join(root, "state"), "--config", configPath, "--mode", "AUTOPILOT"]);

  const report = await runDoctor(productionDoctorProbes(args), { maximum_concurrency: 1, probe_timeout_ms: 8_000 });

  assert.equal(report.status, "FAIL");
  assert.match(report.checks.find((check) => check.id === "codex-runtime")?.summary ?? "", /runtime source must be "bundled"/);
  assert.match(report.checks.find((check) => check.id === "wco-relay-service")?.summary ?? "", /managed WCO Relay.*not been deployed/);
});
