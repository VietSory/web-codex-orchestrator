# Phase 16 — Final Hardening and Local Validation Handoff

## Goal

Phase 16 freezes the GitHub-verifiable WCO v1 control plane after Phase 9–15 and adds a final professional-user product audit across Phase 1–16. The durable path connects registered Web authority, exact application, deterministic verification, independent reviews, normal Git publication, one Draft PR, Result Bundle handoff, explicit Web verdict ingestion, and bounded same-PR revisions. Merge remains human-only.

## Final invariants

1. Browser tabs, ChatGPT conversations, Codex transcripts, session indexes, resume pickers and model output are transport/cache evidence only; none is lifecycle authority.
2. Every mutating/external transition is hash-bound and durably checkpointed before side effects. Retry preserves the sealed request identity and is bounded by attempt/time/model/token budgets. Durable orchestration ledgers are runtime-validated on every read for identity, status/pause semantics, transition/attempt lifecycle, retry/circuit shape, budget accounting, bounded diagnostics/events and event-hash continuity; syntactically valid but semantically contradictory state fails closed.
3. Only explicit Web inputs can satisfy `REGISTER_WEB_PACK` or `WAIT_WEB_VERDICT`. `wco-control continue` accepts `--web-pack` and `--web-verdict` and stops when required input is absent.
4. Phase 10 applies exact registered bytes; Phase 15 reuses only the sealed Phase 7/8 revision authority. No later phase creates a second implementation or revision authority path.
5. Status/snapshot reads use bounded receipts and at most the bounded review/revision round set. They do not deserialize whole Codex/browser histories.
6. Concurrency stays bounded/backpressured. Crash recovery is attempted first; then paused or terminal (`BLOCKED`, `FAILED`, `COMPLETE`) ledgers and unexpired retry deadlines return before external Web pack/verdict input is re-read or canonicalized. `pause` cannot hide a terminal status, and `resume` cannot turn a non-paused terminal run active; a legitimately paused run restores `WAITING`, `ACTIVE`, `BLOCKED`, or `COMPLETE` from durable retry/next-transition/budget state. Retryable transport/rate-limit failures use typed backoff; policy/authority failures are not hot-retried.
7. Logs, diagnostics, event history, subprocess output, Web inputs and receipts remain bounded/compacted. Expensive browser screenshots/traces are diagnostics, not normal polling state.
8. Model/token accounting prevents a new model-bearing transition when the outer budget is exhausted. Completed external side effects remain checkpointed even when a budget boundary is crossed.
9. Git publication does not amend, rebase, destructively force-update an existing branch, delete the branch, mark the PR Ready, enable auto-merge or merge `main`; the Phase 5A empty expected-value lease remains only an atomic create-if-absent race guard, and Phase 8 revisions use exact-head fast-forward publication.
10. The remaining evidence GitHub CI cannot prove is native Windows/WSL/Codex/bridge behavior in `LOCAL-FINAL-CHECKLIST.md`. Public distribution also remains blocked until the maintainer selects an explicit license/distribution policy; the root `LICENSE` is intentionally not auto-filled by WCO.

## Professional-user product hardening

A fresh Phase 1–16 audit discarded the previous maintainer-audit conclusions and re-read code, tests, raw GitHub Actions output and normative phase documents from a user/operator perspective. The audit added or corrected:

- exact PR-head checkout and SHA assertion in CI; prior default PR-merge-ref execution is no longer accepted as exact-head evidence;
- shared-round inbox stabilization with bounded metadata concurrency, eliminating candidate-by-candidate stability sleeps while keeping repository preparation/Git mutation serial;
- watch-mode reuse of stability observations across scans;
- allocation-bounded, identity-stable trusted-config reads and hard safety ceilings for inbox/model/token/Result-Bundle resource knobs;
- bounded Git subprocess time/output for local and network commands, plus a shared exact-binary bounded subprocess path for Phase 6 Git evidence;
- normal cleanup of temporary Phase 5A askpass helpers; credentials remain environment-only;
- bounded Phase 3 root-run and Phase 4 execution-receipt reads;
- bounded execution/agent diagnostic event lines and bounded-tail event sequencing instead of rereading the whole append-only journal on each transition;
- canonical Phase 9 `wco-web-authority register|status` commands with legacy aliases preserved;
- `wco-control doctor` as a run-independent bounded machine preflight for Node/state/config/credential-key presence/Git/pinned Codex/login status;
- concise human control-plane output while preserving full `--json` machine contracts;
- source-checkout npm wrappers so a user does not need a global install or `npm link` merely to operate the private source project;
- accurate root `validate` wording: schema/contract validation does not claim execution eligibility;
- production/test AJV configuration convergence so schema warnings do not pollute CI while semantic assertions remain unchanged.

The executable regressions live in the Phase 16 product/Git/state-bound suites and are part of `test:phase16` and the final release gate.

## Codex/bridge compatibility boundary

Public upstream reports in July 2026 describe session rollout persistence errors being discarded during resume/fork, multi-gigabyte rollout history causing extreme memory growth/OOM on resume, large-session resume-picker freezes, and resume configuration choosing current model/reasoning rather than recorded settings. These are upstream behaviors, not WCO implementation targets.

WCO's mitigation is architectural: lifecycle state is its own bounded durable state; exact thread/session IDs are optional transport handles; model/reasoning authority comes from trusted WCO configuration; persistence failures must surface; retries are sealed and bounded; project/spec context is reconstructed from content-addressed project maps/receipts rather than requiring an immortal conversation. WCO does not modify OpenAI Codex app/CLI/agent internals.

`UPSTREAM-COMPATIBILITY.md` records the broader bridge/browser/session matrix and the local checks required for capabilities GitHub CI cannot exercise.

## Performance and operations freeze

- CPU/RAM: bounded process output, state files, diagnostics, review rounds and worker pools; no global session-history scan.
- Inbox latency: unchanged candidates are observed in shared rounds, with metadata reads chunked to bounded concurrency; expensive prepare/Git work remains deterministic and serial.
- Git/process I/O: local Git has a hard deadline, network Git has a larger hard deadline, output is bounded, and binary evidence uses the same process-tree timeout/cap engine without text conversion.
- Durable state: root/execution receipts are allocation-bounded; append-only execution journal sequencing reads only a bounded tail, and oversized diagnostic events degrade to bounded metadata rather than ballooning one line.
- Tokens/cost: no redundant local implementation turn for Web-authored Phase 10 changes; revision usage is copied once into the outer budget; stable/bounded authority artifacts replace transcript replay; trusted config can tighten but cannot exceed hard product ceilings.
- Recovery: completed lower-layer receipts are re-attested before adoption, so restart does not repeat commit/push/PR/result side effects; pause/resume cannot erase a durable terminal/budget boundary; semantically inconsistent durable state is rejected rather than guessed through.
- Backpressure: bounded resource pools and circuit/backoff policy prevent retry storms and uncontrolled concurrent sessions.

Measured raw GitHub Actions evidence before the added product regressions showed roughly 3–4s dependency install, ~0.5s typecheck, ~78s full unit/fake suite, ~2.2s Phase 8 fake E2E, ~0.6s build and ~2.9s compiled CLI integration on the hosted Ubuntu/Node 20 runner. The slow tests are primarily intentional crash/lock/Git-race hardening, not normal status/control hot paths. Exact timings vary by hosted runner load.

## Final GitHub gate

```bash
npm run phase16:release-gate
```

GitHub CI must check out and assert the exact PR head SHA before running template validation, typecheck, the complete unit/fake suite, Phase 8 fake E2E, build and compiled CLI integration. `PRODUCT-AUDIT.md` records the evidence classification and product-quality report.

## Completion boundary

Phase 16 is GitHub-complete only when the exact head is green, docs/code/tests agree, the PR remains Draft, and the only unresolved release decisions are explicitly external to deterministic GitHub CI: the local native checklist and maintainer-owned licensing/distribution decision.
