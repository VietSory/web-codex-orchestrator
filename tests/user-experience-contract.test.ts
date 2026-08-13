import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFirstRunConfig } from "../src/setup/first-run.js";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fresh user configuration selects one-link managed transport without user relay metadata", () => {
  const config = buildFirstRunConfig({
    root: "/tmp/wco-user-contract",
    repository_id: "wco-user-contract",
    remote: "origin",
    remote_url: "https://github.com/example/wco-user-contract.git",
    expected_remote_urls: ["https://github.com/example/wco-user-contract.git"],
    base_branch: "main",
    base_commit: "a".repeat(40),
    github_repository: "example/wco-user-contract",
  } as any, {
    suggested_commands: [{ id: "test", executable: "npm", args: ["test"] }],
  } as any);
  assert.equal(config.web_bridge?.mode, "managed_actions");
  assert.equal(config.web_bridge?.relay_url, undefined);
  assert.equal(config.web_bridge?.gpt_url, undefined);
});

test("authoritative user docs freeze install + wco + exactly one browser authorization as the normal path", async () => {
  const [readme, contract, bridge] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);
  for (const source of [readme, contract]) {
    assert.match(source, /npm install -g web-codex-orchestrator/);
    assert.match(source, /cd \/path\/to\/project[\s\S]{0,40}\bwco\b/);
    assert.match(source, /exactly one|one.*authorization|one-time.*authorization/i);
    assert.match(source, /no.*tunnel ID|must not.*tunnel ID|never.*tunnel ID/i);
    assert.match(source, /no.*API key|must not.*API key|never.*API key/i);
    assert.match(source, /no.*Workspace Agent.*token|must not.*Workspace Agent.*token|never.*Workspace Agent.*token/i);
    assert.match(source, /per-task browser.*0|no per-task browser|never.*per-task browser/i);
  }
  assert.match(bridge, /default: `managed_actions`/i);
  assert.match(bridge, /one.*authorization/i);
});

test("normal-path docs forbid user-hosted infrastructure and silent fallback", async () => {
  const [contract, bridge, adr] = await Promise.all([
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
    text("docs/adr/0003-one-link-managed-default.md"),
  ]);
  for (const source of [contract, bridge, adr]) {
    assert.match(source, /does not|must never|never|not silently|forbidden/i);
    assert.match(source, /Cloudflare|third-party relay|user-hosted/i);
  }
  assert.match(contract, /Codex\/model reviewer calls = 0/);
  assert.match(contract, /exactly 1 by default/);
  assert.match(contract, /Harness model tokens\s+= 0/);
});