import { strict as assert } from "node:assert";
import test from "node:test";
import { assertCompatibleCodexCliVersion, detectCodexCliVersion, PINNED_CODEX_CLI_VERSION } from "../src/runtime/codex-runtime.js";
import { ExecutionError } from "../src/execution/errors.js";

test("Codex CLI version guard accepts the pinned version", () => {
  assert.equal(PINNED_CODEX_CLI_VERSION, "0.145.0");
  assert.equal(detectCodexCliVersion("codex-cli 0.145.0\n"), "0.145.0");
  assert.equal(assertCompatibleCodexCliVersion("codex-cli 0.145.0\n"), "0.145.0");
});

test("Codex CLI version guard rejects a mismatch or missing version", () => {
  for (const output of ["codex-cli 0.146.0\n", "Codex CLI unavailable\n"]) {
    assert.throws(() => assertCompatibleCodexCliVersion(output), (error: unknown) => error instanceof ExecutionError && error.code === "CODEX_RUNTIME_VERSION_MISMATCH");
  }
});
