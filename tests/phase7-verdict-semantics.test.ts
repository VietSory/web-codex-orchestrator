import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateVerdictPolicy } from "../src/web-review/review-policy-validator.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_RUN_ID } from "./helpers/phase7-fixtures.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";

test("SEMANTICS-001: APPROVE verdict with FAIL criterion is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-sem-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "APPROVE",
      criterion_results: [
        { criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" },
      ],
    });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok(
          (err as WebReviewError).message.includes("schema validation failed") ||
          (err as WebReviewError).message.includes("requires all criteria to be PASS")
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("SEMANTICS-002: APPROVE verdict with blocking findings is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-sem-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "APPROVE",
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "SPEC_VIOLATION",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "line 1",
          expected_behavior: "exp",
          observed_behavior: "obs",
          evidence: "ev",
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
        assert.ok(
          (err as WebReviewError).message.includes("schema validation failed") ||
          (err as WebReviewError).message.includes("cannot contain blocking findings")
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("SEMANTICS-003: REVISE verdict without blocking findings is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-sem-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      criterion_results: [
        { criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" },
      ],
      blocking_findings: [],
    });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 1),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok(
          (err as WebReviewError).message.includes("schema validation failed") ||
          (err as WebReviewError).message.includes("requires at least one fixable blocking finding")
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("SEMANTICS-004: REVISE verdict with escalation-only classification is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-sem-"));
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
          classification: "CRITICAL_SECURITY_EXCEPTION",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "line 1",
          expected_behavior: "exp",
          observed_behavior: "obs",
          evidence: "ev",
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
        assert.ok(
          (err as WebReviewError).message.includes("cannot contain escalation-only classification") ||
          (err as WebReviewError).message.includes("schema validation failed")
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("SEMANTICS-005: REVISE verdict at review round 4 is rejected (exceeds budget)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-sem-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      review_mode: "REVISION",
      review_round: 4,
      criterion_results: [
        { criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" },
      ],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "SPEC_VIOLATION",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "line 1",
          expected_behavior: "exp",
          observed_behavior: "obs",
          evidence: "ev",
          minimal_required_fix: "fix",
          revision_changed_paths: [],
        },
      ],
    });

    await assert.rejects(
      () => validateVerdictPolicy(verdict, loaded, 4),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_INVALID");
        assert.ok(
          (err as WebReviewError).message.includes("invalid at round 4") ||
          (err as WebReviewError).message.includes("schema validation failed")
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
