import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFirstRunConfig } from "../src/setup/first-run.js";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fresh user configuration selects local-native Web transport without relay metadata", () => {
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
  assert.equal(config.web_bridge?.mode, "web_native_mcp");
  assert.equal(config.web_bridge?.relay_url, undefined);
  assert.equal(config.web_bridge?.gpt_url, undefined);
});

test("authoritative user docs freeze local WCO plus one-time official OpenAI setup as the normal path", async () => {
  const [readme, contract, bridge] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);
  for (const source of [contract, bridge]) {
    assert.match(source, /web_native_mcp/);
    assert.match(source, /local|user's machine|same user's machine/i);
    assert.match(source, /Secure MCP Tunnel/i);
    assert.match(source, /one-time.*OpenAI|first.*OpenAI setup/i);
    assert.match(source, /per-task browser interactions\s*= 0|no per-task browser/i);
    assert.match(source, /Cloudflare|ngrok/);
    assert.match(source, /never|does not|no WCO-hosted|not require/i);
  }
  assert.match(readme, /npm install -g web-codex-orchestrator/);
  assert.match(readme, /\bwco\b/);
  assert.match(bridge, /Default: `web_native_mcp`/i);
});

test("normal-path docs forbid WCO hosted infrastructure and silent relay fallback", async () => {
  const [contract, bridge] = await Promise.all([
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);
  for (const source of [contract, bridge]) {
    assert.match(source, /WCO-hosted|WCO SaaS|hosted control plane|hosted backend|managed WCO service/i);
    assert.match(source, /Cloudflare/);
    assert.match(source, /never.*silent|never silently|must never|not require/i);
  }
  assert.match(contract, /Codex\/model reviewer calls = 0/);
  assert.match(contract, /exactly 1 by default/);
  assert.match(contract, /Harness model tokens\s+= 0/);
});

test("normal path explicitly allows provider-owned first-run prerequisites but forbids them per task", async () => {
  const contract = await text("docs/user-experience-contract.md");
  assert.match(contract, /tunnel ID and runtime API key/i);
  assert.match(contract, /per-task tunnel\/key\/token inputs\s*= 0/i);
  assert.match(contract, /claim a single-click provisioning API where OpenAI does not provide one/i);
});