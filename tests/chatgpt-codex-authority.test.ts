import assert from "node:assert/strict";
import test from "node:test";
import { parseChatGptCodexAuthority } from "../src/web-bridge/chatgpt-codex-authority.js";

test("chatgpt_codex rejects unknown provider envelope fields", () => {
  assert.throws(() => parseChatGptCodexAuthority({ protocol_version: "wco-chatgpt-codex-v1", kind: "repository_command", payload_json: JSON.stringify({ operation: "summary" }), extra: true }), /unknown field/i);
});

test("chatgpt_codex reuses the closed repository-command validator", () => {
  const parsed = parseChatGptCodexAuthority({ protocol_version: "wco-chatgpt-codex-v1", kind: "repository_command", payload_json: JSON.stringify({ operation: "summary" }) });
  assert.deepEqual(parsed, { kind: "repository_command", value: { operation: "summary" } });
  assert.throws(() => parseChatGptCodexAuthority({ protocol_version: "wco-chatgpt-codex-v1", kind: "repository_command", payload_json: JSON.stringify({ operation: "summary", shell: "git status" }) }), /unknown field/i);
});

test("chatgpt_codex rejects invalid nested JSON", () => {
  assert.throws(() => parseChatGptCodexAuthority({ protocol_version: "wco-chatgpt-codex-v1", kind: "contract_sealed", payload_json: "{" }), /valid JSON/i);
});
