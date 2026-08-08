# Phase 15 — Durable Same-PR Revision Orchestration

## Goal

Phase 15 extends the durable controller across `REVISE` by reusing the hardened Phase 8 same-PR revision service. A revision starts only from the exact canonical Phase 14 `REVISION_REQUESTED` receipt and its sealed revision request. It finishes only when Phase 8 has fast-forwarded the existing Draft PR branch and produced the exact next Result Bundle.

## Frozen invariants

1. `REVISE` is authorized only by a terminal Phase 14 receipt for the same `run_id`, review round, verdict SHA-256, revision-request SHA-256, decision-event SHA-256, freshly attested published head and Pull Request number. The controller independently reloads the sealed Revision Request before checkpointing.
2. Revision rounds are limited to 1..3. Web review round 4 cannot authorize another revision.
3. Phase 15 reuses `reviseRun`; it does not introduce another implementer/reviewer loop, Git publisher, PR updater or Result Bundle builder.
4. The Phase 8 service remains authoritative for accepted-bundle integrity, clean-worktree checks, path policy, deterministic verification, Terra review, Sol review, normal commit creation, non-force fast-forward push, fresh same-Draft-PR attestation and revision Result Bundle creation.
5. Success requires `RESULT_READY`, exact prior verdict/request/head/PR bindings, `new_published_commit_sha === remote_branch_sha`, non-null Result Bundle and manifest digests, and `next_review_round === revision_round + 1`.
6. Ready-for-review, merge, PR replacement, branch deletion, rebase, amend and force-push remain forbidden.
7. A completed revision returns to `WAIT_WEB_VERDICT`; the controller never fabricates or scrapes the next Web verdict.

## Recovery and concurrency

The outer transition-execution lock serializes one run. The durable ledger seals the complete Phase 14 authority before Phase 8 is entered. Phase 8 has its own per-round lock and durable receipt. Recovery adopts a `REVISE` attempt only when the exact round already has a durable `RESULT_READY` receipt. It then re-enters only Phase 8's terminal verification path to revalidate the exact Result Bundle before completing the outer ledger; an incomplete revision is left for the normal Phase 8 resume path and recovery does not start extra Codex work.

A changed Phase 14 authority cannot be adopted by an in-flight attempt because recovery reconstructs the canonical authority and compares the exact sealed request digest before reading/adopting terminal revision state. Publication/head/result drift fails closed. The recovered round's cumulative model/token usage is committed to the outer ledger exactly once when the previously `STARTED` attempt is completed.

Revision receipts and immutable revision artifacts use synced persistence. Mutable receipts are written to an exclusive temporary file, file-synced, atomically renamed and parent-directory synced on non-Windows platforms. Immutable artifacts are file-synced before atomic hard-link installation; an existing destination is accepted only when its bytes are identical. Windows retains file sync and atomic installation while directory fsync is explicitly not claimed because Node/platform semantics differ.

## Performance, session lifecycle and token accounting

The controller discovers revision state from at most the bounded Phase 8 round set; it does not scan Codex session history, browser tabs or transcripts. Completed revision usage is copied once into the orchestration budget (`model_turns`, input tokens and output tokens), so outer retry/backpressure limits account for real revision model work without replaying prompts or persisting chain-of-thought. A new model-bearing `EXECUTE_REGISTERED_PACK` or `REVISE` attempt is rejected when the global model/token budget is already exhausted.

Phase 8 already reuses the accepted bundle, isolated worktree and bounded agent threads. Revision retries resume only Phase 8's explicit durable checkpoints. GitHub `RATE_LIMITED` failures remain retryable under the controller's bounded deterministic backoff instead of being misclassified as terminal. WCO does not deserialize arbitrary Codex history to discover lifecycle state and does not modify OpenAI Codex app/CLI/agent internals.

## Tests

`tests/phase15-revision-orchestration.test.ts` verifies exact sealed revision execution, same-PR/publication drift failure, quiescence after `RESULT_READY`, authority rejection before an attempt is consumed, crash adoption and exactly-once outer token accounting. `tests/phase15-revision-persistence.test.ts` verifies durable mutable replacement, immutable idempotency/conflict rejection and symlink-destination refusal. Existing Phase 11 controller regressions cover GitHub rate-limit retry classification and global model-budget preflight. The complete existing Phase 8 suite remains authoritative for revision security, verification, Git/GitHub and Result Bundle behavior.

Run:

```bash
npm run phase15:release-gate
```

## Boundary after Phase 15

The complete Web-authority → constrained execution → publish → Draft PR → Result Bundle → Web verdict → same-PR revision loop is durably connected. Phase 16 is final hardening: end-state semantics, operational/performance regressions, exact-head maintainer audits, documentation convergence and the local-only Windows/WSL/native Codex checklist.
