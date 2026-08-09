import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatTaskPreview, previewTaskBundle } from "../src/preview/task-preview.js";
import { copyTemplate, updateChecksums, writeYazlZip } from "./helpers/zip-fixture.js";

test("v0.2 preview exposes scope and verification without preparing a worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-preview-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const bundle = await copyTemplate(root);
  await updateChecksums(bundle);
  const archive = path.join(root, "task.zip");
  await writeYazlZip(bundle, archive);
  const state = path.join(root, "state");

  const preview = await previewTaskBundle(archive, state);

  assert.equal(preview.task_id, "TASK-2026-001");
  assert.equal(preview.title, "Add a health endpoint");
  assert.equal(preview.repository.id, "web-codex-orchestrator");
  assert.equal(preview.delivery.draft, true);
  assert.equal(preview.delivery.auto_merge, false);
  assert.deepEqual(preview.scope.allowed_paths, ["src/**", "tests/**", "package.json"]);
  assert.ok(preview.verification.some((entry) => entry.id === "typecheck" && entry.required));
  assert.ok(preview.verification.some((entry) => entry.id === "test" && entry.required));
  assert.equal(preview.effects.repository_modified, false);
  assert.equal(preview.effects.worktree_created, false);
  assert.equal(preview.effects.network_requested, false);
  await assert.rejects(fs.access(path.join(state, "worktrees")));

  const human = formatTaskPreview(preview);
  assert.match(human, /Scope contract/);
  assert.match(human, /Verification/);
  assert.match(human, /No repository files modified/);
  assert.match(human, /No worktree created/);
  assert.match(human, /No network operation requested/);
});

test("v0.2 preview fails closed if accepted state is replaced by a symlink before a repeated read", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-preview-symlink-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const bundle = await copyTemplate(root);
  await updateChecksums(bundle);
  const archive = path.join(root, "task.zip");
  await writeYazlZip(bundle, archive);
  const state = path.join(root, "state");
  const preview = await previewTaskBundle(archive, state);
  const acceptedManifest = path.join(state, "accepted", preview.task_id, preview.archive_sha256, "bundle", "manifest.json");
  const attackerFile = path.join(root, "attacker-manifest.json");
  await fs.writeFile(attackerFile, "{}\n");
  await fs.rm(acceptedManifest);
  await fs.symlink(attackerFile, acceptedManifest);

  await assert.rejects(
    () => previewTaskBundle(archive, state),
    /regular non-symlink|Cannot safely open/,
  );
});
