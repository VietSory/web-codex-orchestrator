import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readArtifactRegistration } from "../src/web-authority/registry.js";
import { webAuthorityPaths } from "../src/web-authority/paths.js";
import { assertRepositoryRelativePath } from "../src/web-authority/pack-reader.js";
import { validateWebResponseEnvelope } from "../src/web-authority/response-validator.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P9-MAINT-001 operation targets reject traversal, absolute, backslash and .git paths", () => {
  for (const candidate of ["../escape", "/tmp/escape", "C:/escape", "dir\\file", ".git/config", ".git"]) {
    assert.throws(
      () => assertRepositoryRelativePath(candidate),
      (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_OPERATION_INVALID",
      candidate,
    );
  }
  assert.doesNotThrow(() => assertRepositoryRelativePath("src/example.ts"));
});

test("P9-MAINT-002 registered archive mutation is detected on status read", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const paths = webAuthorityPaths(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  await fs.writeFile(paths.archivePath, "tampered\n");
  await assert.rejects(
    () => readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_REGISTRY_INVALID",
  );
});

test("P9-MAINT-003 registry symlink replacement is fail-closed", async (t) => {
  if (process.platform === "win32") { t.skip("Windows symlink creation requires privileges on some runners; covered by path implementation and Linux CI."); return; }
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const paths = webAuthorityPaths(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  const outside = path.join(fixture.root, "outside-registration.json");
  await fs.writeFile(outside, "{}\n");
  await fs.unlink(paths.registrationPath);
  await fs.symlink(outside, paths.registrationPath);
  await assert.rejects(
    () => readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_STATE_DIR_UNSAFE",
  );
});

test("P9-MAINT-004 Web response run identity requires an exact Task Bundle SHA-256", () => {
  assert.throws(
    () => validateWebResponseEnvelope({
      schema_version: "2.0",
      kind: "wco-web-response",
      run_id: "TASK:not-a-sha",
      response_id: "RESP-001",
      in_reply_to_artifact_sha256: "b".repeat(64),
      decision: "APPROVE",
      payload_sha256: "c".repeat(64),
      created_at: "2026-08-08T00:00:00.000Z",
    }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_INVALID_RUN_ID",
  );
});

test("P9-MAINT-005 registration record identity tamper is rejected even when archive bytes remain valid", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const paths = webAuthorityPaths(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  const parsed = JSON.parse(await fs.readFile(paths.registrationPath, "utf8")) as Record<string, unknown>;
  parsed.pack_id = "PACK-TAMPERED";
  parsed.run_id = `OTHER:${fixture.archiveSha}`;
  await fs.writeFile(paths.registrationPath, JSON.stringify(parsed));
  await assert.rejects(
    () => readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_REGISTRY_INVALID",
  );
});
