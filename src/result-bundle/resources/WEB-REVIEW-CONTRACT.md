# WEB REVIEW CONTRACT — CLOSED-WORLD, COMPREHENSIVE REVIEW

## 1. Role

The Web reviewer is the final independent reviewer of one exact Result Bundle.
It is not a second product manager. It may verify the frozen specification but
must not expand it after implementation.

The closed review universe is:

1. `task/spec-lock.json` and its `spec_set_sha256`;
2. the exact authoritative task files covered by that lock;
3. the locked required acceptance criteria and test matrix;
4. the locked security invariants, risk policy and non-goals;
5. the exact Result Bundle SHA-256 and manifest SHA-256;
6. the exact published commit and observed Pull Request head SHA;
7. this review contract and `review/web-review-policy.json`.

No requirement outside that universe can become a normal blocking finding.

## 2. Verdicts

```text
APPROVE
REVISE
ESCALATE
```

### APPROVE

The reviewer MUST return `APPROVE` when:

- exactly one result exists for every locked required acceptance criterion;
- every required criterion is `PASS` with concrete artifact evidence;
- every locked invariant passes;
- there are zero valid blocking findings;
- artifact identity and integrity bindings are valid.

Only `APPROVE` emits the normal user notification asking whether to merge. The
reviewer never merges.

### REVISE

`REVISE` is allowed only for concrete, fixable deviations from the frozen lock:

- `SPEC_VIOLATION`;
- `IMPLEMENTATION_DEFECT`;
- `EVIDENCE_GAP`;
- `REPOSITORY_DRIFT`.

Every finding must identify locked references, exact artifact evidence and the
minimal observable fix. `REVISE` emits no merge prompt and returns a
machine-readable revision request to the automated implementation loop.

### ESCALATE

`ESCALATE` is reserved for cases automation cannot safely resolve under the
frozen lock:

- `SPEC_CONTRADICTION`;
- `HUMAN_REQUIRED`;
- `CRITICAL_SECURITY_EXCEPTION`;
- `ARTIFACT_UNTRUSTED`;
- `REVISION_BUDGET_EXHAUSTED`.

It may notify the user as an exception, never as a merge prompt.

## 3. Mandatory full review on the first Result Bundle

The first Web review is a comprehensive review, not an incremental issue hunt.
It must:

1. validate artifact identity and checksums;
2. evaluate every locked required criterion;
3. emit exactly one criterion result per required criterion;
4. inspect every changed/deleted path and all supplied source/diff evidence;
5. return all currently known valid blockers in one verdict;
6. set `comprehensive_review_complete: true` before returning `APPROVE` or
   `REVISE`.

The reviewer may not intentionally stop after finding the first issue.

## 4. Anti-drip rule for later revision reviews

A later revision review receives the previous Result Bundle, previous verdict,
revision request and the exact revision delta.

A normal new `REVISE` finding is valid only when its origin is one of:

- `PREVIOUS_UNRESOLVED`: a prior blocker is still present;
- `REVISION_REGRESSION`: the requested fix introduced or exposed a defect in a
  path changed by the revision;
- `REVISION_EVIDENCE_INVALIDATION`: revision changes made previously valid
  evidence stale or false.

The reviewer MUST NOT introduce a normal blocker against an unchanged artifact
or criterion that was `PASS` in the previous comprehensive verdict.

A newly discovered critical security fact in unchanged content cannot be hidden,
but it must use `ESCALATE` with `CRITICAL_SECURITY_EXCEPTION`; it may not silently
restart an unbounded `REVISE` loop.

## 5. Non-blocking observations

These cannot prevent approval:

- style preferences;
- alternative architecture preferences;
- optional refactors or optimizations;
- additional features;
- edge cases outside the frozen threat model;
- undocumented personal standards;
- maintainability suggestions with no locked violation.

They may appear only in `non_blocking_backlog`.

## 6. Binding and completeness

Every verdict binds:

- run ID;
- `spec_set_sha256`;
- Result Bundle SHA-256;
- Result Bundle manifest SHA-256;
- reviewed entry-set SHA-256;
- published commit SHA;
- Pull Request number and observed head SHA;
- review contract version and policy version;
- previous bundle/verdict/revision-request hashes for revision reviews.

The verdict validator must reject missing, duplicated or unknown criterion IDs,
stale artifact bindings and invalid verdict/finding combinations.
