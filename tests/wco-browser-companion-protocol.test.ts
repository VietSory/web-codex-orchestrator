import assert from "node:assert/strict";
import test from "node:test";
import {
  WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
  parseWcoBrowserCompanionRequest,
} from "../src/agent/wco-browser-companion-protocol.js";

function validRun(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
    type: "run",
    id: "turn-1",
    mode: "high",
    prompt: "Reply with exactly WCO_WEB_OK",
    ...extra,
  };
}

test("first-party companion accepts only prepared prompt/model metadata", () => {
  assert.deepEqual(parseWcoBrowserCompanionRequest(validRun()), {
    protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
    type: "run",
    id: "turn-1",
    mode: "high",
    prompt: "Reply with exactly WCO_WEB_OK",
  });
});

test("first-party companion rejects repository and bundle authority crossing into Windows", () => {
  for (const forbidden of [
    "workspace_path",
    "accepted_bundle_path",
    "repository_path",
    "bundle_path",
    "git_dir",
    "cwd",
    "command",
    "env",
    "cookies",
    "token",
    "cdp_endpoint",
  ]) {
    assert.throws(
      () => parseWcoBrowserCompanionRequest(validRun({ [forbidden]: "forbidden" })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "WCO_BROWSER_COMPANION_PROTOCOL_INVALID");
        assert.match((error as Error).message, new RegExp(forbidden));
        return true;
      },
      `${forbidden} must never cross the WSL -> Windows model boundary`,
    );
  }
});

test("first-party companion fails closed on protocol drift and unknown request fields", () => {
  assert.throws(
    () => parseWcoBrowserCompanionRequest({ ...validRun(), protocol_version: 999 }),
    /Unsupported browser companion protocol version/,
  );
  assert.throws(
    () => parseWcoBrowserCompanionRequest(validRun({ surprise: true })),
    /unsupported field\(s\): surprise/,
  );
});

test("first-party companion bounds prompt size before native browser execution", () => {
  assert.throws(
    () => parseWcoBrowserCompanionRequest(validRun({ prompt: "x".repeat((512 * 1024) + 1) })),
    /exceeds 524288 bytes/,
  );
});
