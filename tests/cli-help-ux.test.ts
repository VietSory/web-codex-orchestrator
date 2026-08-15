import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

async function help(...args: string[]): Promise<string> {
  const result = await run(process.execPath, ["--import", "tsx", cli, ...args], {
    env: { ...process.env, CI: "true" },
  });
  return result.stdout;
}

test("default CLI help shows the normal user journey without protocol internals", async () => {
  const output = await help("--help");
  assert.match(output, /cd \/path\/to\/project[\s\S]*\bwco\b/);
  assert.match(output, /type a software-engineering goal/i);
  assert.match(output, /wco web connect/);
  assert.match(output, /wco doctor/);
  assert.match(output, /wco help advanced/);
  assert.doesNotMatch(output, /--run-id|task-bundle\.zip|WCO_RUN_ID|package-result|submit-web-verdict/);
});

test("advanced help preserves deterministic protocol commands for operators", async () => {
  const output = await help("help", "advanced");
  assert.match(output, /Advanced deterministic automation/);
  assert.match(output, /task-bundle\.zip/);
  assert.match(output, /--run-id/);
  assert.match(output, /package-result|Result Bundle/i);
});
