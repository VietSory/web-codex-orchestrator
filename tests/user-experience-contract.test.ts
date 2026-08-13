import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFirstRunConfig } from "../src/setup/first-run.js";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fresh user configuration selects local Web-native transport without relay metadata", () => {
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

test("authoritative user docs freeze local-only WCO and prompt-only daily workflow", async () => {
  const [readme, contract, bridge] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);
  for (const source of [readme, contract, bridge]) {
    assert.match(source, /local-first|local-authority|stay on (?:this|the user's) machine/i);
    assert.match(source, /web_native_mcp/);
    assert.match(source, /Secure MCP Tunnel/i);
    assert.match(source, /no WCO-hosted service|WCO-hosted service.*(?:not|required = no)|does not depend on a WCO-hosted service/i);
    assert.match(source, /Cloudflare|ngrok/);
    assert.match(source, /per-task browser.*0|no per-task browser|routine tasks require no browser/i);
  }
  assert.match(readme, /npm install -g web-codex-orchestrator/);
  assert.match(readme, /cd \/path\/to\/project[\s\S]{0,40}\bwco\b/);
});

test("product truth forbids fake provider state and silent third-party fallback", async () => {
  const [contract, bridge, client] = await Promise.all([
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
    text("src/web-bridge/workspace-agent-client.ts"),
  ]);
  assert.match(contract, /provider run-status polling invention\s*= no/i);
  assert.match(bridge, /202 Accepted/);
  assert.match(bridge, /does not parse a fictional response body|does not poll an undocumented run-status endpoint/i);
  assert.match(client, /202 Accepted, no response body/i);
  assert.doesNotMatch(client, /readWorkspaceAgentRun/);
  for (const source of [contract, bridge]) assert.match(source, /never silently|never auto|must not.*silently|never selected automatically/i);
});

test("mode authority invariants remain frozen", async () => {
  const contract = await text("docs/user-experience-contract.md");
  assert.match(contract, /Codex\/model reviewer calls = 0/);
  assert.match(contract, /exactly 1 by default/);
  assert.match(contract, /Harness model tokens\s+= 0/);
  assert.match(contract, /human-only shipment boundary/i);
});
