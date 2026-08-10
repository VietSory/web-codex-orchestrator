import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function repositoryText(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("release-candidate version stays synchronized across package and installed manifest", async () => {
  const packageJson = JSON.parse(await repositoryText("package.json")) as { version?: string };
  const firstRun = await repositoryText("src/setup/first-run.ts");

  assert.equal(packageJson.version, "0.3.2");
  assert.match(firstRun, /version: "0\.3\.2"/);
});

test("public documentation presents the packed Latest release and normal daily workflow truthfully", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");

  assert.match(readme, /Latest public release: \*\*v0\.3\.1\*\*/);
  assert.match(readme, /npm install --global \.\/web-codex-orchestrator-0\.3\.1\.tgz/);
  assert.match(readme, /cd \/path\/to\/project\n+wco/);
  assert.match(readme, /\/web connect/);
  assert.match(operations, /## Normal interactive workflow/);
  assert.match(operations, /## Multiple repositories/);
  assert.doesNotMatch(readme, /stable public package has not been released/i);
  assert.doesNotMatch(operations, /does not currently create/i);
});

test("CI permanently executes the packed daily-user journey gate", async () => {
  const workflow = await repositoryText(".github/workflows/ci.yml");

  assert.match(workflow, /name: Packed daily-user journeys\n\s+run: npm run test:user:packed/);
});
