import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
const Ajv = (Ajv2020 as any).default || Ajv2020 as any;
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(__dirname, "../src/result-bundle/resources");

async function loadSchema(name: string) {
  const content = await fs.readFile(path.join(resourcesDir, name), "utf8");
  return JSON.parse(content);
}

function createValidBaseVerdict(): any {
  return {
    schema_version: "1.1",
    verdict: "APPROVE",
    review_mode: "INITIAL",
    review_round: 1,
    run_id: "TASK-1:abc",
    spec_set_sha256: "0".repeat(64),
    result_bundle_sha256: "0".repeat(64),
    manifest_sha256: "0".repeat(64),
    reviewed_entry_set_sha256: "0".repeat(64),
    published_commit_sha: "0".repeat(40),
    pull_request_number: 1,
    observed_head_sha: "0".repeat(40),
    review_contract_version: "1.1",
    review_policy_version: "1.0",
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    revision_request_sha256: null,
    previous_published_commit_sha: null,
    comprehensive_review_complete: true,
    criterion_results: [{ 
      criterion_id: "REQ-001",
      required: true,
      status: "PASS",
      evidence_refs: ["ref"],
      notes: "ok"
    }],
    blocking_findings: [],
    non_blocking_backlog: [],
    summary: "Good"
  };
}

test("Phase 6 Schema: verdict schema rejects APPROVE with any FAIL/UNVERIFIED criterion", async () => {
  const schema = await loadSchema("web-review-verdict.schema.json");
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  
  const obj = createValidBaseVerdict();
  obj.criterion_results = [{ 
    criterion_id: "REQ-001", required: true, evidence_refs: ["ref"], notes: "ok",
    status: "FAIL"
  }];
  
  assert.equal(validate(obj), false);
  
  obj.criterion_results[0].status = "UNVERIFIED";
  assert.equal(validate(obj), false);

  obj.criterion_results[0].status = "PASS";
  assert.equal(validate(obj), true);
});

test("Phase 6 Schema: verdict schema rejects REVISE with escalation-only classifications", async () => {
  const schema = await loadSchema("web-review-verdict.schema.json");
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const obj = createValidBaseVerdict();
  obj.verdict = "REVISE";
  obj.criterion_results[0].status = "FAIL";
  obj.blocking_findings = [{
    finding_id: "WEB-FIND-001",
    classification: "SPEC_CONTRADICTION", // Escalation only
    finding_origin: "INITIAL_DISCOVERY",
    previous_finding_id: null,
    locked_reference_ids: ["ref"],
    artifact_paths: ["path"],
    line_or_json_pointer: "line 1",
    expected_behavior: "e",
    observed_behavior: "o",
    evidence: "ev",
    minimal_required_fix: "fix",
    revision_changed_paths: []
  }];
  
  assert.equal(validate(obj), false);
  
  obj.blocking_findings[0].classification = "SPEC_VIOLATION";
  if (!validate(obj)) {
    console.error("AJV errors (test 2):", ajv.errorsText(validate.errors));
  }
  assert.equal(validate(obj), true);
});

test("Phase 6 Schema: revision REVISE rejects INITIAL_DISCOVERY findings", async () => {
  const schema = await loadSchema("web-review-verdict.schema.json");
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const obj = createValidBaseVerdict();
  obj.verdict = "REVISE";
  obj.criterion_results[0].status = "FAIL";
  obj.review_mode = "REVISION";
  obj.review_round = 2;
  obj.previous_result_bundle_sha256 = "0".repeat(64);
  obj.previous_verdict_sha256 = "0".repeat(64);
  obj.revision_request_sha256 = "0".repeat(64);
  obj.previous_published_commit_sha = "0".repeat(40);
  
  obj.blocking_findings = [{
    finding_id: "WEB-FIND-001",
    classification: "SPEC_VIOLATION",
    finding_origin: "INITIAL_DISCOVERY", // Reject in revision
    previous_finding_id: "WEB-FIND-000",
    locked_reference_ids: ["ref"],
    artifact_paths: ["path"],
    line_or_json_pointer: "line 1",
    expected_behavior: "e",
    observed_behavior: "o",
    evidence: "ev",
    minimal_required_fix: "fix",
    revision_changed_paths: []
  }];
  
  assert.equal(validate(obj), false);
  
  obj.blocking_findings[0].finding_origin = "PREVIOUS_UNRESOLVED";
  if (!validate(obj)) {
    console.error("AJV errors (test 3):", ajv.errorsText(validate.errors));
  }
  assert.equal(validate(obj), true);
});

test("Phase 6 Schema: initial review bindings require null previous hashes", async () => {
  const schema = await loadSchema("web-review-verdict.schema.json");
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const obj = createValidBaseVerdict();
  obj.review_mode = "INITIAL";
  obj.previous_result_bundle_sha256 = "0".repeat(64); // Invalid
  
  assert.equal(validate(obj), false);
});

test("Phase 6 Schema: revision review bindings require all previous hashes", async () => {
  const schema = await loadSchema("web-review-verdict.schema.json");
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const obj = createValidBaseVerdict();
  obj.review_mode = "REVISION";
  obj.review_round = 2;
  // Missing hashes should fail
  assert.equal(validate(obj), false);
  
  obj.previous_result_bundle_sha256 = "0".repeat(64);
  obj.previous_verdict_sha256 = "0".repeat(64);
  obj.revision_request_sha256 = "0".repeat(64);
  obj.previous_published_commit_sha = "0".repeat(40);
  if (!validate(obj)) {
    console.error("AJV errors:", ajv.errorsText(validate.errors));
  }
  assert.equal(validate(obj), true);
});
