import test from "node:test";

test("optional real Codex integration is opt-in and never runs in normal CI", { skip: process.env.WCO_RUN_CODEX_INTEGRATION !== "1" }, () => {
  // Intentionally not fabricated: a supported runtime must be supplied by a
  // human-run environment before this optional test can be implemented.
});
