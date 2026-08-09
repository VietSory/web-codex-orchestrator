import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DraftPullRequestError, type DraftPullRequestReceipt } from "../src/pull-request/contracts.js";
import { readDraftPullRequestReceipt, writeDraftPullRequestReceipt } from "../src/pull-request/draft-pr-store.js";

function openReceipt(): DraftPullRequestReceipt {
  return {
    receipt_version: "1.0",
    run_id: `TASK-PR-STORE:${"a".repeat(64)}`,
    state: "OPEN",
    repository_owner: "owner",
    repository_name: "repo",
    base_branch: "main",
    head_branch: "codex/task",
    expected_head_sha: "1".repeat(40),
    git_publish_receipt_sha256: "2".repeat(64),
    request_sha256: "3".repeat(64),
    title: "Test Draft PR",
    body_sha256: "4".repeat(64),
    draft_required: true,
    create_post_attempted: true,
    pull_number: 42,
    pull_url: "https://github.com/owner/repo/pull/42",
    observed_head_sha: "1".repeat(40),
    observed_base_branch: "main",
    observed_state: "open",
    observed_draft: true,
    conflict_reason: null,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:01.000Z",
    create_attempted_at: "2026-08-09T00:00:00.000Z",
    opened_at: "2026-08-09T00:00:01.000Z",
    conflict_at: null,
  };
}

test("PR-STORE-HARD-001 stable read returns the exact atomically written receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-pr-store-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, "publish", "github-draft-pr.json");
  await writeDraftPullRequestReceipt(receiptPath, openReceipt());
  assert.deepEqual(await readDraftPullRequestReceipt(receiptPath), openReceipt());
});

test("PR-STORE-HARD-002 symlink receipt is rejected instead of followed", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation can require local developer privileges; Linux CI covers the no-follow boundary.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-pr-store-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const publish = path.join(root, "publish");
  await fs.mkdir(publish);
  const target = path.join(root, "attacker.json");
  await fs.writeFile(target, `${JSON.stringify(openReceipt())}\n`, "utf8");
  const receiptPath = path.join(publish, "github-draft-pr.json");
  await fs.symlink(target, receiptPath);
  await assert.rejects(
    readDraftPullRequestReceipt(receiptPath),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_RECEIPT_INVALID",
  );
});

test("PR-STORE-HARD-003 oversized receipt is rejected before allocation/read", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-pr-store-size-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const publish = path.join(root, "publish");
  await fs.mkdir(publish);
  const receiptPath = path.join(publish, "github-draft-pr.json");
  await fs.writeFile(receiptPath, Buffer.alloc(65_537, 0x20));
  await assert.rejects(
    readDraftPullRequestReceipt(receiptPath),
    (error: unknown) => error instanceof DraftPullRequestError && error.code === "PR_RECEIPT_INVALID",
  );
});
