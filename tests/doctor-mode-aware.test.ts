import assert from "node:assert/strict";
import test from "node:test";
import { parseControlArgs, productionDoctorProbes } from "../src/orchestration/control-cli.js";

function probeIds(mode: "PAIR" | "AUTOPILOT"): string[] {
  const args = parseControlArgs("doctor", [
    "--state-dir", "/tmp/wco-doctor-state",
    "--config", "/tmp/wco-doctor-config.json",
    "--mode", mode,
  ]);
  return productionDoctorProbes(args).map((probe) => probe.id);
}

test("PAIR doctor does not require Codex runtime or authentication", () => {
  const ids = probeIds("PAIR");
  assert.ok(ids.includes("verification-sandbox"));
  assert.ok(!ids.includes("codex-runtime"));
  assert.ok(!ids.includes("codex-auth"));
});

test("AUTOPILOT doctor adds Codex reviewer readiness without replacing deterministic sandbox readiness", () => {
  const ids = probeIds("AUTOPILOT");
  assert.ok(ids.includes("verification-sandbox"));
  assert.ok(ids.includes("codex-runtime"));
  assert.ok(ids.includes("codex-auth"));
});

test("doctor defaults to PAIR and rejects invalid modes", () => {
  const args = parseControlArgs("doctor", [
    "--state-dir", "/tmp/wco-doctor-state",
    "--config", "/tmp/wco-doctor-config.json",
  ]);
  assert.equal(args.doctorMode, "PAIR");
  assert.throws(
    () => parseControlArgs("doctor", [
      "--state-dir", "/tmp/wco-doctor-state",
      "--config", "/tmp/wco-doctor-config.json",
      "--mode", "INVALID",
    ]),
    /--mode must be PAIR or AUTOPILOT/,
  );
});
