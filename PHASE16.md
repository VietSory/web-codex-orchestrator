# Phase 16 — Final Hardening and Local Validation Handoff

## Goal

Phase 16 closes the GitHub/CI side of the stacked v1 control plane. It adds no new authority source. It completes the operator CLI handoff for explicit Web verdict artifacts, hardens GitHub REST backpressure/memory behavior, converges performance/security/compatibility documentation with the implementation, runs the exact-head release gate, and leaves only native Windows/WSL/Codex/codex-chatgpt-web proof to `LOCAL-FINAL-CHECKLIST.md`.

## Frozen invariants

1. Web artifacts remain the only implementation/verdict authority. Browser/chat/session history is transport/cache only.
2. `continue --web-verdict <path>` may feed only the existing `WAIT_WEB_VERDICT` transition. It does not bypass verdict validation, Draft-PR/head attestation, review-round binding, or canonical receipt creation.
3. A supplied verdict is not replayed automatically into a later review round. After a revision returns to `WAIT_WEB_VERDICT`, the control command stops and requires a new explicit verdict artifact.
4. Git publication remains normal fast-forward/non-force and exact-head bound. WCO never marks a PR Ready, merges, rebases/amends published history, deletes phase branches, or weakens tests/contracts to make CI green.
5. GitHub rate-limit failures remain retryable only within the durable attempt/time budget. `Retry-After`, primary reset hints and a documented secondary-limit fallback are bounded metadata, never authority. A server wait longer than the remaining orchestration time budget blocks instead of creating an unbounded sleeper/retry loop.
6. Codex/ChatGPT bridge, browser, session and runtime failures are compatibility boundaries. WCO may detect, checkpoint, bound, retry safely or surface diagnostics, but does not modify OpenAI Codex app/CLI/agent internals.

## Runtime, performance and token posture

The final control loop preserves the Phase 11–15 bounds:

- one execution fence per run plus lower-layer per-operation locks;
- durable, hash-bound attempts/receipts with crash adoption only for exact terminal evidence;
- bounded retry/backoff/circuit behavior and a 24-hour outer elapsed budget;
- bounded ledger events/diagnostics and bounded state/evidence reads;
- bounded subprocess output/deadlines in the WCO process runner;
- explicit direct session/thread handles where the upstream SDK exposes them; no interactive picker/global session-history scan is used to discover WCO lifecycle state;
- `continue` is capped to 1..32 transitions per invocation and stops on human/input boundaries;
- GitHub REST response bodies are capped at 1 MiB and accumulated without repeated whole-buffer concatenation;
- GitHub mutating work remains serialized by WCO transition ownership; rate-limit delays become a durable retry floor rather than a hot loop.

Outer orchestration exactly records the model/input/output usage exposed by completed Phase 8 revision receipts and blocks a new model-bearing transition when the corresponding outer budget is already exhausted. Phase 10 executor receipts do **not** expose token counters in the frozen contract, so Phase 16 does not invent fields or claim that the outer ledger measures every lower-layer model call. Phase 10 reviewer/verifier limits remain enforced by their own bounded gate/runtime policies.

WCO has content-addressed/hash-bound task, implementation, evidence and Result Bundle artifacts. It does **not** claim a separate repository-wide project-map cache subsystem in v1 where no executable implementation exists. Stable context should be reused by immutable identity when available; any future project-map/index cache is derived, deletable and non-authoritative.

## GitHub REST hardening

GitHub documents both primary and secondary rate limits. WCO therefore:

- preserves serial orchestration rather than creating concurrent mutation fan-out;
- parses a valid `Retry-After` delay and `X-RateLimit-Reset` timestamp;
- recognizes a bounded 403 secondary-rate-limit diagnostic without turning ordinary permission-denied 403 responses into retries;
- when GitHub identifies a rate-limit response but provides neither retry header nor an exhausted primary counter, applies GitHub's documented minimum one-minute secondary-limit wait;
- uses the longer valid server hint as a bounded retry floor;
- refuses to wait beyond the remaining orchestration elapsed budget;
- keeps response/error retention bounded and redacts the configured token from diagnostics;
- treats an uncertain create as uncertain and reconciles exact Draft PR state rather than blindly issuing another create.

These behaviors reduce API hammering and memory copying without changing GitHub/PR authority semantics.

## Executable evidence

`tests/phase16-final-hardening.test.ts` covers:

- explicit Web-verdict CLI scope;
- rate-limit failure classification;
- server retry-hint parsing;
- durable retry-floor enforcement;
- elapsed-budget refusal;
- the GitHub 1 MiB response cap;
- secondary-rate-limit 403 recognition plus the one-minute no-header fallback;
- preservation of terminal ordinary permission-denied 403 behavior.

Earlier phase suites remain authoritative for the underlying security/recovery behavior and are rerun by the release gate rather than duplicated or weakened.

Run the exact GitHub-side release gate:

```bash
npm run phase16:release-gate
```

The gate includes typecheck, Phase 13–16 focused suites, the complete unit/fake integration suite, Phase 8 end-to-end integration, build and compiled CLI integration coverage.

## Maintainer audit rule

Final completion requires two independent audits against the **same exact final commit** after CI is green:

- architecture/security/correctness: distrust prior summaries; inspect the phase diff plus authority, transition, recovery, Git/GitHub/security contracts and executable tests directly;
- runtime/performance/operations: independently inspect lifecycle/concurrency/backpressure/retry/state/log/context/token behavior, docs, process/file/resource bounds and executable tests.

Any blocker invalidates both audits. A fix creates a new exact head, CI must pass again, and both audits must be repeated from zero on that new head. Audit reports are recorded outside the Git tree so recording them does not invalidate the audited head.

## Completion boundary

After the exact-head release gate and both audits pass, all work possible through GitHub/CI for Phases 9–16 is complete. Remaining proof is intentionally limited to commands that require the user's real Windows/WSL/native Codex/codex-chatgpt-web environment and is listed in `LOCAL-FINAL-CHECKLIST.md`.
