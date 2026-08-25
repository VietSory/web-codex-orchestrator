import test from "node:test";
import assert from "node:assert/strict";
import {
  CHATGPT_WEB_DOCTOR_PROBE_TIMEOUT_MS,
  doctorProbeTimeoutMs,
  runDoctor,
} from "../src/orchestration/doctor.js";

test("P11-DOCTOR-001 probes are bounded/concurrent and report worst severity", async () => {
  const report = await runDoctor([
    { id: "state", async run() { return { severity: "OK" as const, summary: "state readable" }; } },
    { id: "bridge", async run() { return { severity: "WARN" as const, summary: "bridge not connected" }; } },
    { id: "runtime", async run() { return { severity: "OK" as const, summary: "runtime available" }; } },
  ], { maximum_concurrency: 2, probe_timeout_ms: 200, now: () => new Date("2026-08-08T00:00:00.000Z") });
  assert.equal(report.status, "WARN");
  assert.deepEqual(report.checks.map((item) => item.id), ["bridge", "runtime", "state"]);
  assert.equal(report.generated_at, "2026-08-08T00:00:00.000Z");
});

test("P11-DOCTOR-002 stalled probe becomes a bounded FAIL instead of hanging status", async () => {
  const report = await runDoctor([{ id: "stall", async run() { await new Promise((resolve) => setTimeout(resolve, 100)); return { severity: "OK" as const, summary: "late" }; } }], { probe_timeout_ms: 10 });
  assert.equal(report.status, "FAIL");
  assert.match(report.checks[0]?.summary ?? "", /exceeded 10ms/);
});

test("P11-DOCTOR-003 deadline aborts the underlying probe instead of only racing its Promise", async () => {
  let aborted = false;
  const report = await runDoctor([{
    id: "abortable-stall",
    async run(signal) {
      return await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  }], { probe_timeout_ms: 10 });
  assert.equal(report.status, "FAIL");
  assert.equal(aborted, true);
  assert.match(report.checks[0]?.summary ?? "", /exceeded 10ms/);
});

test("P11-DOCTOR-004 ChatGPT Web readiness gets the real launcher capability-inspection budget only", () => {
  assert.equal(CHATGPT_WEB_DOCTOR_PROBE_TIMEOUT_MS, 130_000);
  assert.equal(doctorProbeTimeoutMs("chatgpt-web", 8_000), 130_000);
  assert.equal(doctorProbeTimeoutMs("state", 8_000), 8_000);
  assert.equal(doctorProbeTimeoutMs("chatgpt-web", 180_000), 180_000);
});
