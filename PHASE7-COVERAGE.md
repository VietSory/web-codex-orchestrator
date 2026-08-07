# Phase 7 — Test Coverage Matrix

## Test Suites Summary

| Test File | Focus Area | Named Cases |
| :--- | :--- | ---: |
| `tests/phase7-verdict-intake.test.ts` | Untrusted verdict source intake and canonicalization | 6 |
| `tests/phase7-result-bundle.test.ts` | Independent Result Bundle verification and bounded review loading | 6 |
| `tests/phase7-verdict-bindings.test.ts` | Mandatory identity bindings and frozen registry checks | 10 |
| `tests/phase7-verdict-semantics.test.ts` | Verdict semantics, classifications, anti-drip and round budget | 5 |
| `tests/phase7-persistence.test.ts` | Idempotency, sealed-round conflicts and read-only status | 3 |
| `tests/phase7-remediation.test.ts` | Phase 7 end-to-end remediation and history regressions | 7 |
| `tests/phase7-remediation-v2.test.ts` | Repository routing, escalation semantics, locks, CLI parsing and deterministic events | 15 |
| `tests/phase7-final-hardening.test.ts` | Task/result archive identity split, embedded schema authority, terminal artifact integrity, contract hashes and GitHub identity | 5 |
| `tests/phase7-final-trusted-run.test.ts` | Mandatory canonical remote identity and trusted remote URL binding | 2 |
| `tests/integration/cli-phase7.integration.test.ts` | Compiled CLI integration | 2 |

Total Phase 7 named cases: **61**.

## Required Release Evidence

A PASS label in this document is not treated as authority by itself. The authoritative release evidence is the exact-head CI/release-gate result. Phase 7 is release-ready only when all of the following succeed on the same head SHA:

```text
npm run typecheck
npm test
npm run build
npm run test:cli
```

`npm run phase7:release-gate` runs the same gate locally.
