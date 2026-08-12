import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("production doctor keeps Codex probes behind the AUTOPILOT mode gate", async () => {
  // This source-level assertion locks the mode boundary without touching config,
  // network, credentials or Codex. The behavioral regression below exercises the
  // production probes when their shared lazy resources fail.
  const source = await readFile(new URL("../src/orchestration/control-cli.ts", import.meta.url), "utf8");
  const gate = source.indexOf('if (args.doctorMode === "AUTOPILOT")');
  assert.ok(gate >= 0, "AUTOPILOT doctor gate must exist");
  const guarded = source.slice(gate);
  assert.match(guarded, /id: "codex-runtime"/);
  assert.match(guarded, /id: "codex-auth"/);
  const common = source.slice(0, gate);
  assert.match(common, /id: "verification-sandbox"/);
  assert.doesNotMatch(common, /id: "codex-runtime"/);
  assert.doesNotMatch(common, /id: "codex-auth"/);
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
