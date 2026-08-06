import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateVerdictPolicy } from "../src/web-review/review-policy-validator.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_RUN_ID } from "./helpers/phase7-fixtures.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";

test("BINDINGS-001: valid verdict passes validateVerdictPolicy", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt);

    const validated = await validateVerdictPolicy(verdict, loaded, 1);
    assert.equal(validated.verdict, "APPROVE");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-002: validateVerdictPolicy rejects run_id mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { run_id: "OTHER-TASK:1111111111111111111111111111111111111111111111111111111111111111" });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("run_id mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-003: validateVerdictPolicy rejects spec_set_sha256 mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { spec_set_sha256: "0".repeat(64) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("spec_set_sha256 mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-004: validateVerdictPolicy rejects result_bundle_sha256 mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { result_bundle_sha256: "0".repeat(64) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("result_bundle_sha256 mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-005: validateVerdictPolicy rejects manifest_sha256 mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { manifest_sha256: "0".repeat(64) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("manifest_sha256 mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-006: validateVerdictPolicy rejects reviewed_entry_set_sha256 mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { reviewed_entry_set_sha256: "0".repeat(64) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("reviewed_entry_set_sha256 mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-007: validateVerdictPolicy rejects published_commit_sha mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { published_commit_sha: "0".repeat(40) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("published_commit_sha mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-008: validateVerdictPolicy rejects observed_head_sha mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: "0".repeat(40) });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("observed_head_sha mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-009: validateVerdictPolicy rejects missing evidence reference in bundle archive", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt);
    verdict.criterion_results[0]!.evidence_refs = ["evidence/nonexistent.json"];

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("Evidence reference not found"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BINDINGS-010: validateVerdictPolicy rejects finding referencing unknown locked reference ID", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bind-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      criterion_results: [
        { criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" },
      ],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "SPEC_VIOLATION",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["UNKNOWN-SPEC-REF"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "line 1",
          expected_behavior: "expected",
          observed_behavior: "observed",
          evidence: "evidence",
          minimal_required_fix: "fix",
          revision_changed_paths: [],
        },
      ],
    });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok((err as WebReviewError).message.includes("references unknown locked ID"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
