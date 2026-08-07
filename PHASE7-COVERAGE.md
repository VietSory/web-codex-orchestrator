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
| `tests/phase7-maintainer-hardening.test.ts` | Fail-closed stale locks, symlink confinement, Draft PR invariants, fresh retry attestation and streaming response caps | 7 |
| `tests/integration/cli-phase7.integration.test.ts` | Compiled CLI APPROVED success path and fail-closed authentication path | 2 |

Total Phase 7 named cases: **68**.

## Adversarial Maintainer Gate

The maintainer hardening suite specifically attempts to invalidate the security claims that are easiest for ordinary happy-path tests to miss:

- an existing stale lock cannot be silently stolen or removed;
- a symlinked `handoff` ancestor cannot redirect Phase 7 writes outside the state root;
- canonical artifact comparison never follows a symlink target;
- both the Phase 6 receipt and fresh GitHub state must still describe a Draft PR;
- an exact terminal retry performs fresh GitHub attestation instead of returning stale approval authority;
- a chunked GitHub response without `Content-Length` is aborted as soon as it crosses the 1 MiB production cap.

## Required Release Evidence

A PASS label in this document is not treated as authority by itself. The authoritative release evidence is the exact-head CI/release-gate result. Phase 7 is release-ready only when all of the following succeed on the same head SHA:

```text
npm run typecheck
npm test
npm run build
npm run test:cli
```

`npm run phase7:release-gate` runs the same gate locally.
