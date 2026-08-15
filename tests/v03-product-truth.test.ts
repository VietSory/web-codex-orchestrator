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

test("public documentation freezes install + one authorization + prompt-only daily workflow", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");
  const contract = await repositoryText("docs/user-experience-contract.md");
  const packageJson = JSON.parse(await repositoryText("package.json")) as { private?: boolean; publishConfig?: { access?: string } };

  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, "public");
  for (const source of [readme, operations, contract]) {
    assert.match(source, /npm install -g (?:\.\/|\\?[^\n]*\/)?web-codex-orchestrator-[^\s`]+\.tgz/i);
    assert.doesNotMatch(source, /npm install -g web-codex-orchestrator\s*(?:\r?\n|$)/i);
  }
  assert.match(readme, /cd \/path\/to\/project\n+wco/);
  assert.match(readme, /Codex official ChatGPT sign-in[\s\S]*Browser authorization/i);
  assert.match(readme, /no `web_bridge` field/i);
  assert.match(readme, /per-task browser interactions\s*=\s*(?:\*\*)?0(?:\*\*)?/i);
  assert.match(readme, /never(?: silently)? falls back/i);
  assert.match(readme, /Publishing(?: WCO)? remains a human maintainer action/i);

  assert.match(operations, /## Normal interactive workflow/);
  assert.match(operations, /## Multiple repositories/);
  assert.match(operations, /one provider-owned ChatGPT authorization interaction/i);
  assert.match(operations, /per-task browser interactions = 0/i);
  assert.match(operations, /web_native_mcp.*advanced|Advanced `web_native_mcp`/is);
});

test("CI keeps real packed install and zero-config product-contract gates separate", async () => {
  const workflow = await repositoryText(".github/workflows/ci.yml");
  const compatibility = await repositoryText(".github/workflows/managed-one-link-packed.yml");

  assert.match(workflow, /name: Clean-install packed CLI without dev dependencies\n\s+run: npm run pack:smoke/);
  assert.match(workflow, /name: Zero-config daily-user contract\n\s+run: npm run test:user:contract/);
  assert.match(compatibility, /compatibility/i);
});
