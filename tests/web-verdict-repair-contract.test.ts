import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseWebVerdictEnvelope, WEB_BRIDGE_PROTOCOL_VERSION } from "../src/web-bridge/contracts.js";

const sha = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

function baseVerdict(verdict: "APPROVE" | "REVISE" | "BLOCK") {
  return {
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    review_id: "review-1",
    run_id: `task:${"a".repeat(64)}`,
    result_bundle_sha256: "b".repeat(64),
    verdict,
    summary: "review summary",
    findings: verdict === "REVISE" ? [{ id: "finding-1", severity: "blocking" as const, description: "fix this" }] : [],
  };
}

test("legacy Web verdict remains valid without repair operations", () => {
  const parsed = parseWebVerdictEnvelope(baseVerdict("APPROVE"));
  assert.equal(parsed.verdict, "APPROVE");
  assert.equal(parsed.repair_operations, undefined);
});

test("REVISE accepts an exact bounded repair payload", () => {
  const before = Buffer.from("before\n");
  const after = Buffer.from("after\n");
  const parsed = parseWebVerdictEnvelope({
    ...baseVerdict("REVISE"),
    repair_operations: [{
      op_id: "repair-1",
      kind: "replace_file",
      path: "src/app.ts",
      preimage_sha256: sha(before),
      postimage_base64: after.toString("base64"),
      postimage_sha256: sha(after),
    }],
  });
  assert.equal(parsed.repair_operations?.length, 1);
  assert.equal(parsed.repair_operations?.[0]?.postimage_sha256, sha(after));
});

test("Web verdict repair rejects tampered postimage bytes", () => {
  const after = Buffer.from("after\n");
  assert.throws(() => parseWebVerdictEnvelope({
    ...baseVerdict("REVISE"),
    repair_operations: [{
      op_id: "repair-1",
      kind: "replace_file",
      path: "src/app.ts",
      preimage_sha256: "c".repeat(64),
      postimage_base64: after.toString("base64"),
      postimage_sha256: "d".repeat(64),
    }],
  }), /Repair postimage encoding or digest is invalid/);
});

test("only REVISE may carry repair operations", () => {
  const after = Buffer.from("after\n");
  assert.throws(() => parseWebVerdictEnvelope({
    ...baseVerdict("APPROVE"),
    repair_operations: [{
      op_id: "repair-1",
      kind: "create_file",
      path: "src/new.ts",
      preimage_sha256: null,
      postimage_base64: after.toString("base64"),
      postimage_sha256: sha(after),
    }],
  }), /Only REVISE may carry repair_operations/);
});

test("repair contract rejects duplicate path authority", () => {
  const first = Buffer.from("one\n"), second = Buffer.from("two\n");
  assert.throws(() => parseWebVerdictEnvelope({
    ...baseVerdict("REVISE"),
    repair_operations: [
      { op_id: "repair-1", kind: "replace_file", path: "src/app.ts", preimage_sha256: "c".repeat(64), postimage_base64: first.toString("base64"), postimage_sha256: sha(first) },
      { op_id: "repair-2", kind: "replace_file", path: "src/app.ts", preimage_sha256: sha(first), postimage_base64: second.toString("base64"), postimage_sha256: sha(second) },
    ],
  }), /duplicate operation id or path/);
});
