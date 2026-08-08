import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDraftPullRequestReceipt } from "../src/pull-request/draft-pr-store.js";
import { readResultBundleReceipt } from "../src/result-bundle/result-bundle-store.js";

const OVERSIZED_RECEIPT_BYTES = 17 * 1024 * 1024;

test("P16-RECEIPT-001 Draft PR receipt reader rejects oversized input instead of retaining it unbounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-draft-receipt-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "github-draft-pr.json");
  await fs.writeFile(file, Buffer.alloc(OVERSIZED_RECEIPT_BYTES, 0x61));
  await assert.rejects(() => readDraftPullRequestReceipt(file));
});

test("P16-RECEIPT-002 Result Bundle receipt reader rejects oversized input instead of retaining it unbounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-result-receipt-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "result-bundle-receipt.json");
  await fs.writeFile(file, Buffer.alloc(OVERSIZED_RECEIPT_BYTES, 0x61));
  await assert.rejects(() => readResultBundleReceipt(file));
});

test("P16-RECEIPT-003 Draft PR receipt reader refuses a symlink", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-draft-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.json");
  const link = path.join(root, "github-draft-pr.json");
  await fs.writeFile(target, "{}\n");
  await fs.symlink(target, link);
  await assert.rejects(() => readDraftPullRequestReceipt(link));
});

test("P16-RECEIPT-004 Result Bundle receipt reader refuses a symlink", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-result-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.json");
  const link = path.join(root, "result-bundle-receipt.json");
  await fs.writeFile(target, "{}\n");
  await fs.symlink(target, link);
  await assert.rejects(() => readResultBundleReceipt(link));
});
