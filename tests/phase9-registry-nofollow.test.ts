import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readArtifactRegistration } from "../src/web-authority/registry.js";
import { webAuthorityPaths } from "../src/web-authority/paths.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P9-NOFOLLOW-001 registered archive symlink replacement is rejected", async (t) => {
  if (process.platform === "win32") { t.skip("Linux CI covers symlink replacement; Windows privilege varies."); return; }
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const sourceArchive = await buildPhase9Pack(fixture);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: sourceArchive });
  const paths = webAuthorityPaths(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  const outside = path.join(fixture.root, "outside.zip");
  await fs.copyFile(sourceArchive, outside);
  await fs.unlink(paths.archivePath);
  await fs.symlink(outside, paths.archivePath);
  await assert.rejects(
    () => readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256),
    (error: unknown) => error instanceof WebAuthorityError && (error.code === "WEB_AUTHORITY_STATE_DIR_UNSAFE" || error.code === "WEB_AUTHORITY_REGISTRY_INVALID"),
  );
});
