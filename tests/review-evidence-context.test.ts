import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_SEMANTIC_REVIEW_EVIDENCE_JSON_BYTES,
  assertSemanticReviewEvidenceBounded,
  exactUtf8ReviewContent,
} from "../src/web-bridge/result-evidence-reader.js";

test("semantic review evidence uses exact readable UTF-8 and rejects invalid bytes", () => {
  const exact = Buffer.from("diff --git a/app.ts b/app.ts\n+export const answer = 42;\n", "utf8");
  assert.equal(exactUtf8ReviewContent(exact, "repository/diff.patch"), exact.toString("utf8"));
  assert.throws(
    () => exactUtf8ReviewContent(Buffer.from([0xff, 0xfe, 0xfd]), "repository/diff.patch"),
    (error: any) => error?.code === "WEB_RESULT_EVIDENCE_INVALID",
  );
});

test("semantic review context fails closed instead of truncating exact evidence", () => {
  const small = {
    purpose: "independent_code_review",
    entries: { "repository/diff.patch": { content_utf8: "+ok\n", sha256: "a".repeat(64), size_bytes: 4 } },
  };
  assert.doesNotThrow(() => assertSemanticReviewEvidenceBounded(small));

  const oversized = { exact: "x".repeat(MAX_SEMANTIC_REVIEW_EVIDENCE_JSON_BYTES + 1) };
  assert.throws(
    () => assertSemanticReviewEvidenceBounded(oversized),
    (error: any) => error?.code === "WEB_RESULT_REVIEW_CONTEXT_LIMIT" && /refuses to truncate evidence/i.test(error.message),
  );
});

test("both review paths preflight semantic context before durable job creation", async () => {
  for (const file of ["src/web-bridge/code-review-service.ts", "src/web-bridge/final-review-service.ts"]) {
    const source = await readFile(file, "utf8");
    const preflight = source.indexOf("assertSemanticReviewEvidenceBounded(payload)");
    const create = source.indexOf("createFinalReviewJob", preflight);
    assert.ok(preflight >= 0, `${file} must qualify the complete review payload`);
    assert.ok(create > preflight, `${file} must fail oversized evidence before creating durable review authority`);
  }
});
