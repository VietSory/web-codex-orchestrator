import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function repositoryText(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("release-candidate version stays synchronized across package and installed manifest", async () => {
  const packageJson = JSON.parse(await repositoryText("package.json")) as { version?: string };
  const firstRun = await repositoryText("src/setup/first-run.ts");

  assert.match(packageJson.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(firstRun, new RegExp(`version: "${packageJson.version!.replaceAll(".", "\\.")}"`));
});

test("public documentation freezes install + exactly-one authorization + prompt-only daily workflow", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");
  const packageJson = JSON.parse(await repositoryText("package.json")) as { private?: boolean; publishConfig?: { access?: string } };

  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.match(readme, /npm install -g web-codex-orchestrator/);
  assert.match(readme, /cd \/path\/to\/project\n+wco/);
  assert.match(readme, /exactly one HTTPS authorization link/i);
  assert.match(readme, /default transport is `managed_actions`/i);
  assert.match(readme, /Per-task browser interactions = \*\*0\*\*/i);
  assert.match(readme, /does \*\*not\*\* configure Cloudflare, ngrok, a VPS/i);
  assert.match(readme, /never asks the normal user for a relay URL, GPT URL, tunnel ID, OpenAI\/API key, Workspace Agent trigger ID, Workspace Agent token/i);
  assert.match(readme, /Publishing remains a human maintainer action/i);
  assert.doesNotMatch(readme, /Install the Latest release[\s\S]{0,1000}gh release download/i);

  assert.match(operations, /## Normal interactive workflow/);
  assert.match(operations, /## Multiple repositories/);
  assert.match(operations, /Exactly one Web authorization link/i);
  assert.match(operations, /per-task browser interactions = 0/i);
  assert.match(operations, /web_native_mcp.*advanced|Advanced.*web_native_mcp/is);
  assert.doesNotMatch(operations, /Personal is recommended|setup --personal.*recommended/i);
});

test("CI permanently executes packed daily-user and one-link managed gates", async () => {
  const workflow = await repositoryText(".github/workflows/ci.yml");
  const managed = await repositoryText(".github/workflows/managed-one-link-packed.yml");

  assert.match(workflow, /name: Packed daily-user journeys\n\s+run: npm run test:user:packed/);
  assert.match(managed, /Packed managed one-link normal-user contract/);
});