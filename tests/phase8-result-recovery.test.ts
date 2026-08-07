import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { packageRevisionResultBundle } from "../src/revision/revision-result-bundle.js";
import { prepareRevisionRoundPaths, resolveRevisionRoundPaths } from "../src/revision/revision-paths.js";
import { writeResultBundleReceipt } from "../src/result-bundle/result-bundle-store.js";
import { createPhase6BundleFixture, TEST_BASE_COMMIT, TEST_PUBLISHED_COMMIT, TEST_RUN_ID } from "./helpers/phase7-fixtures.js";

const H = (c: string) => c.repeat(64);

test("P8-MAINT-006: retry after revision Result Bundle is ready reuses the exact verified archive", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-result-recovery-")));
  try {
    const fixture = await createPhase6BundleFixture(root);
    const paths = resolveRevisionRoundPaths(fixture.stateDirectory, TEST_RUN_ID, 1);
    await prepareRevisionRoundPaths(fixture.stateDirectory, paths);
    const archivePath = path.join(paths.resultDirectory, "recovered-result.zip");
    await fs.copyFile(fixture.archivePath, archivePath);

    const previousHead = "9".repeat(40);
    const requestSha = H("7");
    const previousReceiptSha = H("8");
    const readyReceipt = {
      ...fixture.receipt,
      result_bundle_version: "1.2" as const,
      input_kind: "revision" as const,
      revision_round: 1,
      state: "READY_FOR_WEB_REVIEW" as const,
      revision_evidence_sha256: H("1"),
      revision_request_sha256: requestSha,
      previous_result_bundle_sha256: H("2"),
      previous_result_receipt_sha256: previousReceiptSha,
      previous_verdict_sha256: H("3"),
      previous_published_commit_sha: previousHead,
      previous_pr_head_sha: previousHead,
      published_commit_sha: TEST_PUBLISHED_COMMIT,
      remote_branch_sha: TEST_PUBLISHED_COMMIT,
      archive_relative_path: path.relative(fixture.stateDirectory, archivePath).replace(/\\/g, "/"),
    };
    await writeResultBundleReceipt(paths.resultReceiptPath, readyReceipt);

    const source: any = {
      request: {
        run_id: TEST_RUN_ID,
        revision_round: 1,
        spec_set_sha256: fixture.receipt.spec_set_sha256,
        previous_result_bundle_sha256: readyReceipt.previous_result_bundle_sha256,
        previous_verdict_sha256: readyReceipt.previous_verdict_sha256,
        previous_published_commit_sha: previousHead,
        previous_pr_head_sha: previousHead,
        pull_request_number: readyReceipt.pull_request.number,
      },
      requestSha256: requestSha,
      previousResultBundle: { phase6ReceiptSha256: previousReceiptSha },
    };
    const revisionReceipt: any = {
      state: "PUSHED",
      revision_round: 1,
      revision_request_sha256: requestSha,
      new_published_commit_sha: TEST_PUBLISHED_COMMIT,
      remote_branch_sha: TEST_PUBLISHED_COMMIT,
    };

    const before = await fs.readFile(archivePath);
    const recovered = await packageRevisionResultBundle({
      stateDirectory: fixture.stateDirectory,
      paths,
      source,
      revisionReceipt,
      revisionEvidence: {},
      revisionEvidenceSha256: H("1"),
      publishEvidence: {},
      publishEvidenceSha256: H("4"),
      prAttestation: {} as any,
      acceptedBundlePath: path.join(root, "not-used-on-ready-recovery"),
      originalBaseCommit: TEST_BASE_COMMIT,
      worktreePath: root,
      runner: new GitRunner(),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const after = await fs.readFile(archivePath);

    assert.equal(recovered.archive_sha256, readyReceipt.archive_sha256);
    assert.equal(recovered.manifest_sha256, readyReceipt.manifest_sha256);
    assert.deepEqual(after, before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
