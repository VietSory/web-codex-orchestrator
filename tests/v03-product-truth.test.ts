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

test("public documentation presents the packed Latest release and normal daily workflow truthfully", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");

  const latestStart = readme.indexOf("## Install the Latest release");
  const latestEnd = readme.indexOf("## Daily use");
  assert.ok(latestStart >= 0 && latestEnd > latestStart);
  const latestSection = readme.slice(latestStart, latestEnd);
  assert.match(latestSection, /gh release view --repo VietSory\/web-codex-orchestrator --json tagName/);
  assert.match(latestSection, /release_version="\$\{release_tag#v\}"/);
  assert.match(latestSection, /gh release download "\$release_tag"/);
  assert.match(latestSection, /sha256sum -c "\$\{release_asset\}\.sha256"/);
  assert.match(latestSection, /npm install --global "\.\/\$\{release_asset\}"/);
  assert.match(latestSection, /test "\$\(wco --version\)" = "\$release_version"/);
  assert.doesNotMatch(latestSection, /(?:\bv|web-codex-orchestrator-)\d+\.\d+\.\d+/);
  assert.doesNotMatch(readme, /Latest public release[^\n]*v\d+\.\d+\.\d+/i);
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
