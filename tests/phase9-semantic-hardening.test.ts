import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { validateWebImplementationPackSemantics } from "../src/web-authority/semantic-validator.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { WebAuthorityError, type WebImplementationPack } from "../src/web-authority/contracts.js";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";

function replaceEntry(pack: WebImplementationPack, name: string, value: unknown): WebImplementationPack {
  const entries = new Map(pack.entries);
  entries.set(name, canonicalJsonBuffer(value));
  return { ...pack, entries };
}

test("P9-SEM-001 source receipt enums are runtime-enforced", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  const mutated = replaceEntry(pack, "source-receipts.json", {
    schema_version: "2.0",
    receipts: [{
      source_id: "SRC-001",
      source_type: "browser_magic",
      locator: "fixture://requirements",
      accessed_at: "2026-08-08T00:00:00.000Z",
      content_sha256: "a".repeat(64),
      authority: "absolute_truth",
    }],
  });
  assert.throws(
    () => validateWebImplementationPackSemantics(mutated),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_SOURCE_INVALID",
  );
});

test("P9-SEM-002 read coverage must bind the exact inventory blob object", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  const mutated = replaceEntry(pack, "read-coverage.json", {
    schema_version: "2.0",
    repository_tree_sha: fixture.treeSha,
    reads: [{ path: "app.txt", object_sha: "f".repeat(40), coverage: "full" }],
  });
  assert.throws(
    () => validateWebImplementationPackSemantics(mutated),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-SEM-003 project-map paths must exist exactly once in inventory", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  const mutated = replaceEntry(pack, "project-map.json", {
    schema_version: "2.0",
    repository_tree_sha: fixture.treeSha,
    nodes: [{ path: "does-not-exist.ts", role: "invented" }],
  });
  assert.throws(
    () => validateWebImplementationPackSemantics(mutated),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-SEM-004 accepted Task Bundle drift invalidates a previously built pack", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  await fs.writeFile(`${fixture.bundle}/REQUEST.md`, "mutated after Web pack creation\n");
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-SEM-005 closed-world source documents reject unexpected fields", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  const mutated = replaceEntry(pack, "source-receipts.json", {
    schema_version: "2.0",
    receipts: [],
    loose_override: true,
  });
  assert.throws(() => validateWebImplementationPackSemantics(mutated), WebAuthorityError);
});
