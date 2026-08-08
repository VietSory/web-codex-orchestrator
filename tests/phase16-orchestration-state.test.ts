import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readSelectedArtifactSelection,
  writeSelectedArtifactFile,
} from "../src/orchestration/artifact-binding.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";
import { orchestrationPaths } from "../src/orchestration/paths.js";

const RUN_ID = `TASK-P16-STATE:${"a".repeat(64)}`;

function selection(overrides: Record<string, unknown> = {}) {
  return {
    selection_version: "1.0",
    run_id: RUN_ID,
    artifact_sha256: "b".repeat(64),
    manifest_sha256: "c".repeat(64),
    pack_id: "PACK-P16",
    selected_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  } as never;
}

test("P16-STATE-001 selected artifact state replaces exact bytes without temp residue", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-write-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = orchestrationPaths(root, RUN_ID);
  await fs.mkdir(paths.directory, { recursive: true });
  await writeSelectedArtifactFile(paths.selectedArtifactPath, selection());
  await writeSelectedArtifactFile(paths.selectedArtifactPath, selection({ selected_at: "2026-08-08T00:00:01.000Z" }));
  const parsed = JSON.parse(await fs.readFile(paths.selectedArtifactPath, "utf8")) as { selected_at: string };
  assert.equal(parsed.selected_at, "2026-08-08T00:00:01.000Z");
  assert.deepEqual((await fs.readdir(paths.directory)).sort(), ["selected-artifact.json"]);
});

test("P16-STATE-002 selected artifact writer refuses a symlink destination", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = orchestrationPaths(root, RUN_ID);
  await fs.mkdir(paths.directory, { recursive: true });
  const target = path.join(paths.directory, "protected.json");
  await fs.writeFile(target, "protected\n");
  await fs.symlink(target, paths.selectedArtifactPath);
  await assert.rejects(
    () => writeSelectedArtifactFile(paths.selectedArtifactPath, selection()),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_ARTIFACT_INVALID",
  );
  assert.equal(await fs.readFile(target, "utf8"), "protected\n");
});

test("P16-STATE-003 selected artifact reader rejects oversized state before registry lookup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-large-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = orchestrationPaths(root, RUN_ID);
  await fs.mkdir(paths.directory, { recursive: true });
  await fs.writeFile(paths.selectedArtifactPath, Buffer.alloc(64 * 1024 + 1, 0x61));
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_ARTIFACT_INVALID",
  );
});

test("P16-STATE-004 selected artifact reader rejects invalid selected_at before registry lookup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-selected-time-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = orchestrationPaths(root, RUN_ID);
  await fs.mkdir(paths.directory, { recursive: true });
  await fs.writeFile(paths.selectedArtifactPath, JSON.stringify(selection({ selected_at: "not-a-date" })));
  await assert.rejects(
    () => readSelectedArtifactSelection(root, RUN_ID),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_ARTIFACT_INVALID",
  );
});
