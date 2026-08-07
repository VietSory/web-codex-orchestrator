import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPhase9Fixture,
  buildPhase9Pack,
} from "./helpers/phase9-fixture.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readArtifactRegistration } from "../src/web-authority/registry.js";
import { validateWebResponseEnvelope } from "../src/web-authority/response-validator.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P9-AUTH-001 valid pack is snapshot-bound, registered and idempotently adopted", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const pack = await readAndValidateWebImplementationPack(archive);
  assert.equal(pack.manifest.repository.tree_sha, fixture.treeSha);
  const record = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
    now: () => new Date("2026-08-08T00:01:00.000Z"),
  });
  assert.equal(record.artifact_sha256, pack.archive_sha256);
  const stored = await readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  assert.equal(stored?.pack_id, "PACK-P9-001");
  const adopted = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
    now: () => new Date("2026-08-08T00:02:00.000Z"),
  });
  assert.equal(adopted.artifact_sha256, record.artifact_sha256);
});

test("P9-AUTH-002 checksum tamper is rejected before registration", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture, { corruptPayloadAfterChecksums: true });
  await assert.rejects(
    () => readAndValidateWebImplementationPack(archive),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_CHECKSUM_MISMATCH",
  );
});

test("P9-AUTH-003 a self-consistent false preimage cannot create authority", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture, { wrongPreimage: true });
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_PREIMAGE_INVALID",
  );
});

test("P9-AUTH-004 Web inventory must equal the exact Git inventory", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture, { wrongInventory: true });
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-AUTH-005 dirty worktree invalidates the locked Web snapshot", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  await fs.writeFile(path.join(fixture.repo, "untracked.txt"), "drift\n");
  await assert.rejects(
    () => registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_BINDING_MISMATCH",
  );
});

test("P9-AUTH-006 response envelope is closed-world and artifact-bound", () => {
  const valid = validateWebResponseEnvelope({
    schema_version: "2.0",
    kind: "wco-web-response",
    run_id: `TASK:${"a".repeat(64)}`,
    response_id: "RESP-001",
    in_reply_to_artifact_sha256: "b".repeat(64),
    decision: "REVISE",
    payload_sha256: "c".repeat(64),
    created_at: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(valid.decision, "REVISE");
  assert.throws(() => validateWebResponseEnvelope({ ...valid, loose_patch: "override" }), WebAuthorityError);
});
