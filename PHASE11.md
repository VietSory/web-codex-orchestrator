# Phase 11 — Durable Orchestration

## Goal

Phase 11 turns the existing Phase 3–10 primitives into a durable control plane that can survive process restart, transport failures and operator pauses without treating a browser tab, Codex thread, transcript or retry loop as canonical state. The first milestone remains **Verified Task Autopilot / Single-PR Core Alpha**; merge remains human-owned.

## Non-negotiable invariants

1. Durable mission/task state belongs to WCO, not a browser tab, Codex thread or chat session.
2. Every external/model/network/mutating transition is checkpointed before the call with an exact request SHA-256 and deterministic attempt ID.
3. Completion/failure is fenced by that exact attempt ID. A late result from an expired/replaced attempt cannot advance state.
4. Each run has one durable single-writer lock. A live competing writer is backpressured; a stale/malformed lock is never auto-stolen because read/unlink replacement races cannot be made safe with the portable Node filesystem API.
5. Retry budgets, token/turn budgets and circuit state persist across restart. Retry not-before timestamps are enforced before another attempt can start.
6. Retryable transport failures use bounded exponential backoff with deterministic jitter/cap. No hot restart/retry loop.
7. Derived logs/history/caches never authorize a transition. Authorization comes from canonical phase receipts/artifacts and persisted budget/counter state.
8. History is bounded: the hot ledger stores a hash-chained event tail plus compaction anchor. Retry authority uses persisted counters, never the compacted event window.
9. Repeated identical diagnostics are deduplicated. Worker concurrency and queues are bounded with explicit backpressure.
10. Pause prevents new transitions but does not erase a sealed checkpoint. Status/next/doctor stay cheap and must not initialize Codex/browser/network work unless explicitly requested.
11. Merge, dangerous data operations, breaking product decisions and other human-policy gates remain human decisions.

## Persistence and recovery

Canonical state is `<state>/orchestration/runs/<task-id>/<task-bundle-sha256>/run-ledger.json`. Ledger reads are bounded and reject symlink/non-regular/identity-changing files. Writes use a same-directory exclusive temporary file, `FileHandle.sync()`, atomic rename, and a parent-directory sync on non-Windows platforms. Node exposes `O_NOFOLLOW` only on platforms that support it; WCO therefore keeps lstat/file-identity checks as the portable defense and does not claim Windows directory-entry fsync semantics that Node does not expose portably.

A process crash may leave `orchestrator.lock`. WCO deliberately fails closed rather than stealing that lock. `doctor`/Phase 16 recovery UX must surface the precise repair action. This is preferable to an unsafe auto-unlink race that could delete a newly acquired writer lock.

## Retry / resource / token policy

Default retry policy starts at 1s, doubles per durable transition attempt, applies deterministic 75–125% jitter, caps at 60s, opens the circuit after five consecutive failures for 120s, allows at most four attempts per transition and 24 total attempts. All numeric bounds are finite and validated.

Separate bounded pools remain required for Web/browser turns, Codex/model turns, deterministic verifier processes, Git/network mutations and later mission tasks. Content/evidence is referenced by immutable hashes rather than copied into the hot ledger. Sealed request payloads are reused on retry. Token/turn usage is persisted.

## Upstream compatibility negative requirements

WCO must remain correct when Codex session persistence/listing/resume is slow, incomplete or divergent. Upstream reports include openai/codex issues #35385 (rollout persistence errors can create in-memory/on-disk divergence), #19517 and #22037 (resume/thread listing scans many rollout files), #22411 (thread/list can repeatedly deserialize all sessions and consume idle CPU), and #30932 (very large rollout history can cause unbounded resume memory growth). Therefore WCO never uses Codex thread history as recovery authority, never requires global thread/list scans for status, keeps its own bounded checkpoint state, and will prefer direct known session identifiers when Phase 12 can do so safely. WCO does not patch OpenAI internals.

Node filesystem grounding: Node documents `FileHandle.sync()` as requesting that file data be flushed to the storage device, `fsPromises.rename()` as rename only, and `O_NOFOLLOW` as unavailable on Windows. The implementation follows those portability boundaries rather than assuming POSIX behavior everywhere.

## UX surface and remaining Phase 11 closure

The control plane remains centered on `wco-control continue|next|status|doctor|pause|resume`. The next closure batch integrates the exact Phase 9 registration → Phase 10 executor → publish lifecycle into this hardened controller, adds compiled CLI coverage, exact-result adoption/restart regressions and a Phase 11 release gate. `status` and `next` remain read-only/cheap; `continue` must stop at Web/human gates.

## Exit criteria

- bounded/no-follow durable ledger and lock/state confinement;
- durable single-writer state transitions and no silent lock stealing;
- sealed request/attempt identity before external work and attempt-ID fenced result adoption;
- persisted retry/backoff/circuit/budget state with enforced retry timestamps;
- pause/resume and bounded resource pools/backpressure;
- planner/driver integration for the single-PR lifecycle;
- cheap status/next/doctor and compiled CLI;
- crash/restart/late-result/retry-budget/concurrency/token regressions;
- exact-head release gate plus strict maintainer audit.
