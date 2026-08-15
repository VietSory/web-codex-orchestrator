import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFirstRunConfig } from "../src/setup/first-run.js";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fresh user configuration leaves the normal Web transport implicit", () => {
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

  assert.equal(config.web_bridge, undefined);
});

test("authoritative docs freeze local one-authorization prompt-only workflow", async () => {
  const [readme, contract, bridge] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
  ]);

  assert.match(readme, /npm install -g \.\/web-codex-orchestrator-[^\s`]+\.tgz/);
  for (const source of [contract, bridge]) {
    assert.match(source, /local ChatGPT\/Codex/i);
    assert.match(source, /no `web_bridge` field|no `web_bridge`/i);
    assert.match(source, /official.*ChatGPT|ChatGPT.*official/i);
    assert.match(source, /no browser action|per-task browser interactions\s*= 0/i);
    assert.match(source, /never.*fallback|never a silent fallback|must not silently switch/i);
  }
});

test("the first normal goal may trigger official ChatGPT authorization without a manual connect command", async () => {
  const [interactive, bridge] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/web-bridge/chatgpt-codex-bridge.ts"),
  ]);

  assert.match(interactive, /if \(isLocal\(\)\) \{\s+if \(bridge\) return true;/s);
  assert.doesNotMatch(interactive, /if \(isLocal\(\)\) \{[^}]*Run \/web connect to authorize/s);
  assert.match(bridge, /createAuthoringJob[\s\S]*ensureAuthorizedForProviderTurn/);
  assert.match(bridge, /before durable task creation/i);
});

test("PAIR status and review stay read-only while presenting durable lifecycle evidence", async () => {
  const interactive = await text("src/tui/interactive-app.ts");
  const statusStart = interactive.indexOf('if (command === "/status")');
  const reviewStart = interactive.indexOf('if (command === "/review")');
  const pauseStart = interactive.indexOf('if (command === "/pause"');
  assert.ok(statusStart >= 0 && reviewStart > statusStart && pauseStart > reviewStart);

  const statusBlock = interactive.slice(statusStart, reviewStart);
  assert.match(statusBlock, /readLifecycleSnapshot/);
  assert.match(statusBlock, /formatPairStatus/);
  assert.doesNotMatch(statusBlock, /runControlCommand|startAndDriveTask|drivePairHarnessToCodeReview|driveAutopilotJob/);

  const reviewBlock = interactive.slice(reviewStart, pauseStart);
  assert.match(reviewBlock, /reviewSummary/);
  assert.doesNotMatch(reviewBlock, /runControlCommand|startAndDriveTask|drivePairHarnessToCodeReview|driveAutopilotJob/);
});

test("normal path keeps mutation and shipment authority local and human-owned", async () => {
  const contract = await text("docs/user-experience-contract.md");
  const bridge = await text("docs/web-bridge.md");

  assert.match(contract, /Harness mutation authority/i);
  assert.match(contract, /human alone decides merge\/release/i);
  assert.match(contract, /automatic merge\/release\s+= 0/i);
  assert.match(bridge, /WCO validates/i);
  assert.match(bridge, /human merge\/release/i);
});

test("advanced compatibility profiles remain explicit", async () => {
  const bridge = await text("docs/web-bridge.md");
  assert.match(bridge, /web_native_mcp/);
  assert.match(bridge, /managed_actions/);
  assert.match(bridge, /manual_file/);
  assert.match(bridge, /explicit compatibility profiles|advanced compatibility profiles/i);
});
