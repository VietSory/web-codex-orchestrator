import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFirstRunConfig } from "../src/setup/first-run.js";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fresh user configuration selects official Web-native transport without relay metadata", () => {
  const config = buildFirstRunConfig({
    repository: {
      root: "/tmp/wco-user-contract",
      repository_id: "wco-user-contract",
      remote: "origin",
      remote_url: "https://github.com/example/wco-user-contract.git",
      base_branch: "main",
      base_commit: "a".repeat(40),
      github_repository: "example/wco-user-contract",
    },
    project: { package_manager: "npm", verification_commands: ["npm test"], allowed_executables: ["npm", "node"] },
  } as any);
  assert.equal(config.web_bridge?.mode, "web_native_mcp");
  assert.equal(config.web_bridge?.relay_url, undefined);
  assert.equal(config.web_bridge?.gpt_url, undefined);
});

test("authoritative user docs expose only npm + wco + one-time official OpenAI setup as the normal path", async () => {
  const [readme, contract, bridge] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);
  for (const source of [readme, contract]) {
    assert.match(source, /npm install -g web-codex-orchestrator/);
    assert.match(source, /cd \/path\/to\/project[\s\S]{0,40}\bwco\b/);
    assert.match(source, /first run only|first-run|one-time/i);
    assert.match(source, /official OpenAI\/ChatGPT|official OpenAI/i);
    assert.match(source, /OPENAI_CAPABILITY_BLOCKED/);
  }
  assert.match(bridge, /default: `web_native_mcp`/i);
  assert.match(bridge, /does not require Cloudflare, ngrok, a VPS/i);
});

test("normal-path docs explicitly forbid silent third-party fallback", async () => {
  const [contract, bridge, adr] = await Promise.all([
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
    text("docs/adr/0002-official-openai-web-native-default.md"),
  ]);
  for (const source of [contract, bridge, adr]) {
    assert.match(source, /does not|must never|never|not silently|no.*fallback/i);
    assert.match(source, /Cloudflare|third-party relay/i);
  }
  assert.match(contract, /Codex\/model reviewer calls = 0/);
  assert.match(contract, /exactly 1 by default/);
  assert.match(contract, /Harness model tokens\s+= 0/);
});