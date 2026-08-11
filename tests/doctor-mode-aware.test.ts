import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseControlArgs } from "../src/orchestration/control-cli.js";

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
  // This source-level regression assertion is intentionally side-effect free:
  // constructing production probes currently prepares shared async resources.
  // Runtime execution is covered by the existing doctor tests; this test locks
  // the product boundary without touching config, network, credentials or Codex.
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
