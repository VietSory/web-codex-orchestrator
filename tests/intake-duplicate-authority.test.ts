import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { intakeArchive } from "../src/intake/intake-service.js";
import { IntakeError } from "../src/intake/errors.js";
import { copyTemplate, writeYazlZip } from "./helpers/zip-fixture.js";

async function acceptedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wco-intake-authority-"));
  const archivePath = path.join(root, "task.zip");
  const stateDirectory = path.join(root, ".wco");
  const bundle = await copyTemplate(root);
  await writeYazlZip(bundle, archivePath);
  const receipt = await intakeArchive(archivePath, stateDirectory);
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") assert.fail("fixture must be accepted");
  const receiptPath = path.join(stateDirectory, "accepted", receipt.task_id, receipt.archive_sha256, "intake.json");
  return { root, archivePath, stateDirectory, receipt, receiptPath };
}

test("P2-AUTH-001 duplicate intake rejects receipt body/path archive rebinding", async (t) => {
  const fixture = await acceptedFixture();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const body = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  body.archive_sha256 = "f".repeat(64);
  await writeFile(fixture.receiptPath, `${JSON.stringify(body)}\n`);
  await assert.rejects(
    () => intakeArchive(fixture.archivePath, fixture.stateDirectory),
    (error: unknown) => error instanceof IntakeError && error.code === "OPERATIONAL_ERROR",
  );
});

test("P2-AUTH-002 duplicate intake rejects stored_bundle rebinding", async (t) => {
  const fixture = await acceptedFixture();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const body = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  body.stored_bundle = `accepted/${fixture.receipt.task_id}/${fixture.receipt.archive_sha256}/not-the-bundle`;
  await writeFile(fixture.receiptPath, `${JSON.stringify(body)}\n`);
  await assert.rejects(
    () => intakeArchive(fixture.archivePath, fixture.stateDirectory),
    (error: unknown) => error instanceof IntakeError && error.code === "OPERATIONAL_ERROR",
  );
});

test("P2-AUTH-003 duplicate intake re-attests the retained accepted source archive", async (t) => {
  const fixture = await acceptedFixture();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const retainedSource = path.join(
    fixture.stateDirectory,
    "accepted",
    fixture.receipt.task_id,
    fixture.receipt.archive_sha256,
    "source.zip",
  );
  await writeFile(retainedSource, "tampered retained archive");
  await assert.rejects(
    () => intakeArchive(fixture.archivePath, fixture.stateDirectory),
    (error: unknown) => error instanceof IntakeError && error.code === "OPERATIONAL_ERROR",
  );
});
