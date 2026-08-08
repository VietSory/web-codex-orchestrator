import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { rewriteWebPackJson } from "./helpers/web-pack-mutator.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P9-ATTACK-001 Git-valid slash branch is accepted by the pack parser", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const mutated = await rewriteWebPackJson({ archivePath: archive, entryPath: "implementation-pack.json", mutate: (manifest) => ({
    ...manifest,
    repository: { ...(manifest.repository as Record<string, unknown>), base_branch: "release/1.x" },
  }) });
  const pack = await readAndValidateWebImplementationPack(mutated);
  assert.equal(pack.manifest.repository.base_branch, "release/1.x");
});

test("P9-ATTACK-002 Git-invalid branch remains fail-closed", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const mutated = await rewriteWebPackJson({ archivePath: archive, entryPath: "implementation-pack.json", mutate: (manifest) => ({
    ...manifest,
    repository: { ...(manifest.repository as Record<string, unknown>), base_branch: "release..evil" },
  }) });
  await assert.rejects(() => readAndValidateWebImplementationPack(mutated), (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_MANIFEST_INVALID");
});

test("P9-ATTACK-003 checksum-consistent invalid source enums cannot be registered", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const mutated = await rewriteWebPackJson({ archivePath: archive, entryPath: "source-receipts.json", mutate: (document) => ({
    ...document,
    receipts: [{
      source_id: "SRC-001",
      source_type: "browser_magic",
      locator: "fixture://requirements",
      accessed_at: "2026-08-08T00:00:00.000Z",
      content_sha256: "a".repeat(64),
      authority: "absolute_truth",
    }],
  }) });
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: mutated }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_SOURCE_INVALID",
  );
});

test("P9-ATTACK-004 checksum-consistent false read coverage cannot be registered", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const mutated = await rewriteWebPackJson({ archivePath: archive, entryPath: "read-coverage.json", mutate: (document) => ({
    ...document,
    reads: [{ path: "app.txt", object_sha: "f".repeat(40), coverage: "full" }],
  }) });
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: mutated }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-ATTACK-005 checksum-consistent invented project-map path cannot be registered", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const mutated = await rewriteWebPackJson({ archivePath: archive, entryPath: "project-map.json", mutate: (document) => ({
    ...document,
    nodes: [{ path: "invented.ts", role: "fake" }],
  }) });
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: mutated }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});
