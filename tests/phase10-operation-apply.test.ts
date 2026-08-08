import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack, sha256 } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { readAndValidateWebImplementationPack } from "../src/web-authority/pack-reader.js";
import { preflightWebOperations } from "../src/web-authority/operation-preflight.js";
import { applyWebOperations, recoverWebOperationTransaction } from "../src/web-authority/operation-apply.js";
import { WebAuthorityError } from "../src/web-authority/contracts.js";

test("P10-APPLY-001 registered operation applies with durable journal and exact postimage", async (t) => {
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
  const plan = await preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack });

  const result = await applyWebOperations({ stateDirectory: fixture.state, plan, pack });

  assert.equal(result.status, "committed");
  assert.equal(result.applied_operations, 1);
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "after\n");
  const journal = JSON.parse(await fs.readFile(result.journal_path, "utf8")) as {
    status: string;
    plan_sha256: string;
    completed_operation_indexes: number[];
  };
  assert.equal(journal.status, "committed");
  assert.equal(journal.plan_sha256, plan.plan_sha256);
  assert.deepEqual(journal.completed_operation_indexes, [0]);
});

test("P10-APPLY-002 drift after preflight fails closed and leaves the drift untouched", async (t) => {
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
  const plan = await preflightWebOperations({ worktreeRoot: fixture.repo, registration, pack });
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "drift\n");

  await assert.rejects(
    () => applyWebOperations({ stateDirectory: fixture.state, plan, pack }),
    (error: unknown) => error instanceof WebAuthorityError && error.code === "WEB_AUTHORITY_PREIMAGE_INVALID",
  );
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "drift\n");
});

test("P10-APPLY-003 crash recovery restores a checksummed preimage idempotently", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const transactionDirectory = path.join(fixture.state, "manual-transaction");
  const backupDirectory = path.join(transactionDirectory, "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  const original = Buffer.from("before\n", "utf8");
  await fs.writeFile(path.join(backupDirectory, "0000.bin"), original);
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "partially-applied\n");
  const journalPath = path.join(transactionDirectory, "journal.json");
  await fs.writeFile(journalPath, JSON.stringify({
    schema_version: "1.0",
    run_id: fixture.runId,
    artifact_sha256: "f".repeat(64),
    plan_sha256: "e".repeat(64),
    worktree_root: fixture.repo,
    status: "applying",
    backups: [{
      operation_index: 0,
      relative_path: "app.txt",
      original_sha256: sha256(original),
      backup_relative_path: "backups/0000.bin",
      backup_sha256: sha256(original),
    }],
    completed_operation_indexes: [0],
    updated_at: new Date().toISOString(),
  }));

  const recovered = await recoverWebOperationTransaction({ journalPath });
  assert.equal(recovered.status, "rolled_back");
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "before\n");
  const repeated = await recoverWebOperationTransaction({ journalPath });
  assert.equal(repeated.status, "rolled_back");
});
