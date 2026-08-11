import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWebCodeReviewReceipt } from "../src/web-bridge/code-review-service.js";
import { WebBridgeError } from "../src/web-bridge/contracts.js";

const RUN_ID = `PAIR-STATE:${"a".repeat(64)}`;

function isStateError(error: unknown): boolean {
  return error instanceof WebBridgeError && error.code === "WEB_CODE_REVIEW_STATE_INVALID";
}

test("Web code-review receipt rejects a symlinked state ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-code-review-state-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-code-review-outside-"));
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await symlink(outside, path.join(root, "bridge", "code-reviews"), "dir");
  await assert.rejects(() => readWebCodeReviewReceipt(root, RUN_ID), isStateError);
});

test("Web code-review receipt never follows a final-file symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-code-review-file-"));
  const directory = path.join(root, "bridge", "code-reviews", "PAIR-STATE", "a".repeat(64));
  await mkdir(directory, { recursive: true });
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, path.join(directory, "receipt.json"));
  await assert.rejects(() => readWebCodeReviewReceipt(root, RUN_ID), isStateError);
});
