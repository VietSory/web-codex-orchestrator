import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSelectedArtifactSelection } from "../src/orchestration/artifact-binding.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";
import { orchestrationPaths } from "../src/orchestration/paths.js";

const TASK_ID = "TASK-P16-STATE";
const TASK_BUNDLE_SHA256 = "a".repeat(64);
const RUN_ID = `${TASK_ID}:${TASK_BUNDLE_SHA256}`;

function selectedArtifactPath(root: string): string {
  return path.join(orchestrationPaths(root, TASK_ID, TASK_BUNDLE_SHA256).directory, "selected-artifact.json");
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    run_id: RUN_ID,
    artifact_sha256: "b".repeat(64),
    registration_manifest_sha256: "c".repeat(64),
    selected_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

test("P16-STATE-001 selected artifact reader rejects oversized state before registry lookup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-large-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = selectedArtifactPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(16 * 1024 + 1, 0x61));
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_STATE_INVALID",
  );
});

test("P16-STATE-002 selected artifact reader refuses a symlink", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = selectedArtifactPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const target = path.join(path.dirname(file), "protected.json");
  await fs.writeFile(target, JSON.stringify(binding()));
  await fs.symlink(target, file);
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_STATE_INVALID",
  );
});

test("P16-STATE-003 selected artifact reader rejects malformed JSON before registry lookup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-json-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = selectedArtifactPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not-json}\n");
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_STATE_INVALID",
  );
});

test("P16-STATE-004 selected artifact reader rejects invalid selected_at before registry lookup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-time-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = selectedArtifactPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(binding({ selected_at: "not-a-date" })));
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_STATE_INVALID",
  );
});
