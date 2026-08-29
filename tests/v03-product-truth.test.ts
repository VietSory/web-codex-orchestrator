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

test("public documentation freezes first-party browser PAIR without Codex fallback", async () => {
  const readme = await repositoryText("README.md");
  const operations = await repositoryText("docs/operations.md");
  const contract = await repositoryText("docs/user-experience-contract.md");
  const bridge = await repositoryText("docs/web-bridge.md");
  const architecture = await repositoryText("docs/architecture.md");
  const packageJson = JSON.parse(await repositoryText("package.json")) as { private?: boolean; publishConfig?: { access?: string } };

  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, "public");
  for (const source of [readme, operations, contract]) {
    assert.match(source, /npm install -g (?:\.\/|\\?[^\n]*\/)?web-codex-orchestrator-[^\s`]+\.tgz/i);
    assert.doesNotMatch(source, /npm install -g web-codex-orchestrator\s*(?:\r?\n|$)/i);
  }

  for (const source of [readme, operations, contract, bridge, architecture]) {
    assert.match(source, /WCO[- ]owned Windows (?:browser )?companion|WCO Windows companion/i);
    assert.match(source, /Temporary Chat/i);
  }

  assert.match(readme, /cd \/path\/to\/project\n+wco/);
  assert.match(readme, /provider preference.*chatgpt-web|defaults.*chatgpt-web/is);
  assert.match(readme, /Codex provider(?:\/model)? turns\s+=\s*0/i);
  assert.match(readme, /per-task manual browser interactions\s+=\s*0/i);
  assert.match(readme, /fails closed|fail-closed/i);
  assert.match(readme, /Publishing WCO remains a human maintainer action/i);
  assert.doesNotMatch(readme, /delegates authorization to its \*\*bundled official Codex runtime\*\*/i);

  assert.match(operations, /## Normal interactive workflow/);
  assert.match(operations, /## Multiple repositories/);
  assert.match(operations, /Codex provider\/model turns in PAIR\s+=\s*0/i);
  assert.match(operations, /per-task manual browser interactions\s*=\s*0/i);
  assert.match(operations, /never\s+silently\s+falls?\s+back|never a silent fallback|must not silently fall back/i);

  assert.match(contract, /"provider": "chatgpt-web"/i);
  assert.match(contract, /Codex provider\/model turns\s+=\s*0/i);
  assert.match(contract, /per-task manual browser interactions\s+=\s*0/i);
  assert.match(contract, /never silently fall back/i);

  assert.match(bridge, /Only an explicit persisted `provider: "codex"` selects/i);
  assert.match(bridge, /Browser automation itself is expected/i);
  assert.doesNotMatch(bridge, /Browser DOM automation.*not supported normal transports/i);
});

test("CI keeps real packed install and zero-config product-contract gates separate", async () => {
  const workflow = await repositoryText(".github/workflows/ci.yml");
  const compatibility = await repositoryText(".github/workflows/managed-one-link-packed.yml");

  assert.match(workflow, /name: Clean-install packed CLI without dev dependencies\n\s+run: npm run pack:smoke/);
  assert.match(workflow, /name: Zero-config daily-user contract\n\s+run: npm run test:user:contract/);
  assert.match(compatibility, /compatibility/i);
});
