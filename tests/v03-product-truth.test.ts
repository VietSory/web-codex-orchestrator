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

test("public documentation freezes the three-step npm/Web-native daily workflow", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");
  const packageJson = JSON.parse(await repositoryText("package.json")) as { private?: boolean; publishConfig?: { access?: string } };

  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.match(readme, /npm install -g web-codex-orchestrator/);
  assert.match(readme, /cd \/path\/to\/project\n+wco/);
  assert.match(readme, /\/web connect\s+one-time official OpenAI\/ChatGPT Web-native setup/i);
  assert.match(readme, /web_native_mcp/);
  assert.match(readme, /OPENAI_CAPABILITY_BLOCKED/);
  assert.match(readme, /does \*\*not\*\* configure Cloudflare, ngrok, a VPS/i);
  assert.match(readme, /publishing remains a human release action/i);
  assert.doesNotMatch(readme, /Install the Latest release[\s\S]{0,1000}gh release download/i);

  assert.match(operations, /## Normal interactive workflow/);
  assert.match(operations, /## Multiple repositories/);
  assert.match(operations, /web_native_mcp/);
  assert.match(operations, /OPENAI_CAPABILITY_BLOCKED/);
  assert.doesNotMatch(operations, /Personal is recommended|setup --personal.*recommended/i);
});

test("CI permanently executes the packed daily-user journey gate", async () => {
  const workflow = await repositoryText(".github/workflows/ci.yml");

  assert.match(workflow, /name: Packed daily-user journeys\n\s+run: npm run test:user:packed/);
});