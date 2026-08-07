import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readArtifactRegistration } from "../src/web-authority/registry.js";
import { webAuthorityPaths } from "../src/web-authority/paths.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P9-REG-MANIFEST-001 valid-format registration binding tamper is rejected against archive manifest", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const record = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const paths = webAuthorityPaths(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256);
  const parsed = JSON.parse(await fs.readFile(paths.registrationPath, "utf8")) as typeof record;
  parsed.bindings = { ...parsed.bindings, spec_set_sha256: "f".repeat(64) };
  await fs.writeFile(paths.registrationPath, JSON.stringify(parsed));
  await assert.rejects(
    () => readArtifactRegistration(fixture.state, fixture.taskId, fixture.archiveSha, record.artifact_sha256),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_REGISTRY_INVALID",
  );
});
