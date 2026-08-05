import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Phase 6 CLI Integration - compiled CLI loads resources", async (t) => {
  const rootDir = path.resolve(__dirname, "../..");
  
  // Ensure we have built the project (we assume `npm run build` was run before tests,
  // but to be safe we can just check if dist/cli/index.js exists)
  const cliPath = path.join(rootDir, "dist", "cli", "index.js");
  try {
    await fs.access(cliPath);
  } catch {
    assert.fail("CLI not built. Run 'npm run build' before testing.");
  }

  const stateDir = path.join(rootDir, "tests", "fixtures", "tmp-cli-phase6-state");
  await fs.mkdir(stateDir, { recursive: true });

  try {
    const { stdout, stderr } = await execFileAsync("node", [
      cliPath,
      "package-result",
      "--run-id", "test-task:0000000000000000000000000000000000000000000000000000000000000000",
      "--state-dir", stateDir,
      "--config", "missing-config.json",
      "--json"
    ]);

    // Should output JSON error
    const out = JSON.parse(stdout);
    assert.strictEqual(out.status, "FAILED");
  } catch (error: any) {
    if (error.stdout) {
      const out = JSON.parse(error.stdout);
      assert.strictEqual(out.status, "FAILED");
      assert.ok(out.error.code === "RESULT_CONFIG_INVALID" || out.error.code === "RESULT_OPERATIONAL_ERROR" || out.error.code === "RESULT_EXECUTION_RECEIPT_INVALID", `Got unexpected error code: ${out.error.code}`);
    } else {
      throw error;
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }

  // Explicitly check that resources were copied
  const resourcesDir = path.join(rootDir, "dist", "result-bundle", "resources");
  const files = await fs.readdir(resourcesDir);
  assert.ok(files.includes("WEB-REVIEW-CONTRACT.md"));
  assert.ok(files.includes("web-review-policy.json"));
  assert.ok(files.includes("web-review-verdict.schema.json"));
  assert.ok(files.includes("revision-request.schema.json"));
});
