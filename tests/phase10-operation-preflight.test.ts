import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack, sha256 } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { preflightWebOperations } from "../src/web-authority/operation-preflight.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P10-PREFLIGHT-001 registered pack produces a deterministic mutation-free plan", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
  });
  const pack = await readAndValidateWebImplementationPack(archive);
  const before = await fs.readFile(path.join(fixture.repo, "app.txt"));

  const first = await preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack });
  const second = await preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack });

  assert.equal(first.plan_sha256, second.plan_sha256);
  assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0]?.observed_preimage_sha256, sha256(before));
  assert.equal(first.operations[0]?.payload_sha256, sha256("after\n"));
  assert.deepEqual(await fs.readFile(path.join(fixture.repo, "app.txt")), before);
});

test("P10-PREFLIGHT-002 preimage drift fails before any mutation", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
  });
  const pack = await readAndValidateWebImplementationPack(archive);
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "drifted\n");

  await assert.rejects(
    () => preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_PREIMAGE_INVALID",
  );
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "drifted\n");
});

test("P10-PREFLIGHT-003 symlink target is rejected fail-closed", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
  });
  const pack = await readAndValidateWebImplementationPack(archive);
  const outside = path.join(fixture.root, "outside.txt");
  await fs.writeFile(outside, "before\n");
  await fs.unlink(path.join(fixture.repo, "app.txt"));
  await fs.symlink(outside, path.join(fixture.repo, "app.txt"));

  await assert.rejects(
    () => preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_PREIMAGE_INVALID",
  );
  assert.equal(await fs.readFile(outside, "utf8"), "before\n");
});
