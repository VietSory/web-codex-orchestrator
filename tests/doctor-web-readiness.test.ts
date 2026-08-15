import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor, type DoctorProbe } from "../src/orchestration/doctor.js";

function probe(id: string, severity: "OK" | "WARN" | "FAIL", summary = id): DoctorProbe {
  return { id, async run() { return { severity, summary }; } };
}

test("selected Web transport warnings are non-ready failures", async () => {
  for (const id of ["wco-relay-service", "wco-device-account", "chatgpt-web", "senior-architect-gpt"]) {
    const report = await runDoctor([probe(id, "WARN", "selected Web capability unavailable")], { maximum_concurrency: 1 });
    assert.equal(report.status, "FAIL", id);
    assert.equal(report.checks[0]?.severity, "FAIL", id);
  }
});

test("non-Web advisory warnings remain warnings", async () => {
  const report = await runDoctor([probe("credentials", "WARN", "optional credential warning")], { maximum_concurrency: 1 });
  assert.equal(report.status, "WARN");
  assert.equal(report.checks[0]?.severity, "WARN");
});

test("profile-aware Web probes that return OK remain ready", async () => {
  const report = await runDoctor([
    probe("wco-relay-service", "OK", "manual/native profile says relay is not required"),
    probe("wco-device-account", "OK", "profile says managed account is not required"),
    probe("chatgpt-web", "OK"),
    probe("senior-architect-gpt", "OK"),
  ], { maximum_concurrency: 2 });
  assert.equal(report.status, "OK");
});
