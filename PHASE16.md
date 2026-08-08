# Phase 16 — Final Hardening and Local Validation Handoff

## Goal

Phase 16 closes the GitHub/CI side of the stacked v1 control plane. It does not add a new authority source. It hardens the existing durable loop, makes the operator CLI accept an explicit Web verdict artifact, normalizes retryable GitHub rate-limit behavior, runs the exact-head release gate, converges documentation, and leaves only native Windows/WSL/Codex/codex-chatgpt-web checks to `LOCAL-FINAL-CHECKLIST.md`.

## Frozen invariants

1. Web artifacts remain the only implementation/verdict authority. Browser/chat/session history is transport/cache only.
2. `continue --web-verdict <path>` may feed only the existing `WAIT_WEB_VERDICT` transition. It does not bypass verdict validation, Draft-PR/head attestation, review-round binding, or canonical receipt creation.
3. A supplied verdict is not replayed automatically into a later review round. After a revision returns to `WAIT_WEB_VERDICT`, the control command stops and requires a new explicit verdict input.
4. Git publication remains non-force and exact-head bound. WCO never marks a PR Ready, merges, rebases/amends published history, deletes phase branches, or weakens tests/contracts to make CI green.
5. Retryable GitHub rate-limit variants are classified as retryable, while policy/authority failures remain terminal. Retry hints are bounded metadata only; they never authorize an operation.
6. Codex/ChatGPT bridge, browser, session and runtime failures are compatibility boundaries. WCO may detect, checkpoint, bound, retry safely or surface diagnostics, but does not modify OpenAI Codex app/CLI/agent internals.

## Runtime, performance and token posture

The final control loop preserves the Phase 11–15 bounds: one transition lock per run, durable attempts/receipts, bounded retry/backoff, global model/token budgets, bounded subprocess output, content-addressed project/context reuse and no session-history scan for lifecycle discovery. `continue` is capped to 1..32 transitions per invocation and still stops on human/input boundaries.

Project maps, immutable artifacts and sealed request hashes are reused by identity. Stable repository/chat context is not regenerated merely because a transport retry or new browser session occurs. Late/expired external results cannot advance durable state. Status/doctor paths remain non-model diagnostic surfaces.

## Executable evidence

`tests/phase16-final-hardening.test.ts` covers the Phase 16 CLI input boundary and retry classification regressions. Earlier phase suites remain authoritative for the underlying security/recovery/performance behavior rather than being duplicated or weakened.

Run the exact GitHub-side release gate:

```bash
npm run phase16:release-gate
```

The gate includes typecheck, Phase 13–16 focused suites, the complete unit suite, Phase 8 end-to-end integration, build and CLI integration coverage.

## Maintainer audit rule

Final completion requires two independent audits against the same exact head after CI is green:

- architecture/security/correctness: distrust prior summaries; inspect phase diff plus authority, transition, recovery, Git/GitHub and security contracts and executable tests;
- runtime/performance/operations: independently inspect lifecycle/concurrency/backpressure/retry/state/log/context/token behavior, docs and executable tests.

Any blocker invalidates both audits. Fixes must create a new head, exact-head CI must pass again, and both audits must be repeated on that new head.

## Completion boundary

After the exact-head release gate and both audits pass, GitHub-side Phase 9–16 work is complete. Remaining proof that cannot be produced by GitHub CI is intentionally limited to the native commands in `LOCAL-FINAL-CHECKLIST.md`.
