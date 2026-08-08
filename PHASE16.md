# Phase 16 — Final Hardening and Local Validation Handoff

## Goal

Phase 16 freezes the GitHub-verifiable WCO v1 control plane after Phase 9–15. The durable path now connects registered Web authority, exact application, deterministic verification, independent reviews, normal Git publication, one Draft PR, Result Bundle handoff, explicit Web verdict ingestion, and bounded same-PR revisions. Merge remains human-only.

## Final invariants

1. Browser tabs, ChatGPT conversations, Codex transcripts, session indexes, resume pickers and model output are transport/cache evidence only; none is lifecycle authority.
2. Every mutating/external transition is hash-bound and durably checkpointed before side effects. Retry preserves the sealed request identity and is bounded by attempt/time/model/token budgets. Durable orchestration ledgers are runtime-validated on every read for identity, status/pause semantics, transition/attempt lifecycle, retry/circuit shape, budget accounting, bounded diagnostics/events and event-hash continuity; syntactically valid but semantically contradictory state fails closed.
3. Only explicit Web inputs can satisfy `REGISTER_WEB_PACK` or `WAIT_WEB_VERDICT`. `wco-control continue` accepts `--web-pack` and `--web-verdict` and stops when required input is absent.
4. Phase 10 applies exact registered bytes; Phase 15 reuses only the sealed Phase 7/8 revision authority. No later phase creates a second implementation or revision authority path.
5. Status/snapshot reads use bounded receipts and at most the bounded review/revision round set. They do not deserialize whole Codex/browser histories.
6. Concurrency stays bounded/backpressured. Crash recovery is attempted first; then paused or terminal (`BLOCKED`, `FAILED`, `COMPLETE`) ledgers and unexpired retry deadlines return before external Web pack/verdict input is re-read or canonicalized. `pause` cannot hide a terminal status, and `resume` cannot turn a non-paused terminal run active; a legitimately paused run restores `WAITING`, `ACTIVE`, `BLOCKED`, or `COMPLETE` from durable retry/next-transition/budget state. Retryable transport/rate-limit failures use typed backoff; policy/authority failures are not hot-retried.
7. Logs, diagnostics, event history, subprocess output, Web inputs and receipts remain bounded/compacted. Expensive browser screenshots/traces are diagnostics, not normal polling state.
8. Model/token accounting prevents a new model-bearing transition when the outer budget is exhausted. Completed external side effects remain checkpointed even when a budget boundary is crossed.
9. Git publication is normal fast-forward only. WCO does not amend, rebase, destructively force-update an existing branch, delete the branch, mark the PR Ready, enable auto-merge or merge `main`; the Phase 5A empty expected-value lease remains only an atomic create-if-absent race guard.
10. The only remaining release evidence that GitHub CI cannot prove is native Windows/WSL/Codex/bridge behavior listed in `LOCAL-FINAL-CHECKLIST.md`.

## Codex/bridge compatibility boundary

Public upstream reports in July 2026 describe session rollout persistence errors being discarded during resume/fork, multi-gigabyte rollout history causing extreme memory growth/OOM on resume, large-session resume-picker freezes, and resume configuration choosing current model/reasoning rather than recorded settings. These are upstream behaviors, not WCO implementation targets.

WCO's mitigation is architectural: lifecycle state is its own bounded durable state; exact thread/session IDs are optional transport handles; model/reasoning authority comes from trusted WCO configuration; persistence failures must surface; retries are sealed and bounded; project/spec context is reconstructed from content-addressed project maps/receipts rather than requiring an immortal conversation. WCO does not modify OpenAI Codex app/CLI/agent internals.

`UPSTREAM-COMPATIBILITY.md` records the broader bridge/browser/session matrix and the local checks required for capabilities GitHub CI cannot exercise.

## Performance and operations freeze

- CPU/RAM: bounded process output, state files, diagnostics, review rounds and worker pools; no global session-history scan.
- I/O: content-addressed repository/project-map reuse and deterministic evidence avoid repeated full-repository/context assembly where the contract permits reuse; terminal ledger state and retry backoff are checked before re-reading external Web inputs after recovery.
- Tokens: no redundant local implementation turn for Web-authored Phase 10 changes; revision usage is copied once into the outer budget; stable/bounded authority artifacts replace transcript replay.
- Recovery: completed lower-layer receipts are re-attested before adoption, so restart does not repeat commit/push/PR/result side effects; pause/resume cannot erase a durable terminal/budget boundary; semantically inconsistent durable state is rejected rather than guessed through.
- Backpressure: bounded resource pools and circuit/backoff policy prevent retry storms and uncontrolled concurrent sessions.

## Final GitHub gate

```bash
npm run phase16:release-gate
```

The exact final head must also have green GitHub CI. After that head is fixed, two independent maintainer-style audits are required: architecture/security/correctness and runtime/performance/operations. Any blocker invalidates both audits; after a fix and new exact-head CI, both audits restart from zero.

## Completion boundary

Phase 16 is GitHub-complete only when the exact head is green, both audits pass, docs/code/tests agree, the PR remains Draft, and `LOCAL-FINAL-CHECKLIST.md` contains the only remaining native checks.
