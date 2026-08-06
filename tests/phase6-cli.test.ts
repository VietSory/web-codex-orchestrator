import test from "node:test";
import assert from "node:assert";
import { runPackageResultCommand, runResultBundleStatusCommand } from "../src/result-bundle/result-bundle-cli.js";

test("Phase 6 CLI: requires args", async () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = (str: string | Uint8Array) => {
    stderr += str.toString();
    return true;
  };
  try {
    const code = await runPackageResultCommand(["node", "wco", "package-result"]);
    assert.equal(code, 2);
    assert.ok(stderr.includes("Usage:"));
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test("Phase 6 CLI: fails when config is missing", async () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = (str: string | Uint8Array) => {
    stderr += str.toString();
    return true;
  };
  try {
    const code = await runPackageResultCommand(["node", "wco", "package-result", "--run-id", "A", "--state-dir", "B"]);
    assert.equal(code, 2);
    assert.ok(stderr.includes("Usage:"));
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});
