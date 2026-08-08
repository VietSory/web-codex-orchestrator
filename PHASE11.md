# Phase 11 — Durable Orchestration

## Goal

Phase 11 turns Phase 3–10 primitives into a durable single-PR control plane that can survive process restart, transport failures and operator pauses without treating a browser tab, Codex thread, transcript or retry loop as canonical state. Merge remains human-owned.

## Frozen invariants

1. WCO owns durable mission/task state; browser/Codex session history is never authority.
2. Every external/model/network/mutating transition is checkpointed before the call with an exact request SHA-256 and deterministic attempt ID.
3. Completion/failure is fenced by that attempt ID; stale/late results cannot advance a newer attempt.
4. `orchestrator.lock` serializes durable state mutation. `transition-execution.lock` additionally fences one whole external transition so two `continue` callers cannot concurrently execute the same sealed attempt.
5. Locks are exclusive-created, file-synced, ownership/identity checked and never auto-stolen. A stale/malformed lock requires explicit operator repair because portable read/unlink cannot safely distinguish replacement races.
6. Retry budgets, not-before timestamps, token/turn budgets and circuit state persist across restart. Retry authority uses durable counters, not compacted events.
7. Retry uses bounded exponential backoff with deterministic jitter and cap; no hot loops.
8. Ledger/event/diagnostic state is bounded. Derived logs/caches/history never authorize transitions.
9. Selected registered artifacts are exact Phase 9 registrations, bounded/no-follow read, manifest-bound, atomically persisted and file-synced before use.
10. P10 READY publication is re-attested against canonical Phase 3/9 authority, transaction backups, persisted gate evidence and exact current change-set before Phase 4 publication.
11. Operator pause blocks new attempts and survives completion/failure of an already-started external attempt.
12. `next` and absent-state `status` are cheap; `next` is read-only and does not need trusted config. `pause`/`resume` do not need config. `doctor`/`continue` require config.
13. Merge/dangerous decisions remain human gates.

## Lifecycle implemented

`wco-control continue` advances at most the bounded `--max-transitions` count and stops at input/Web/human boundaries. The production path now integrates:

`REGISTER_WEB_PACK -> EXECUTE_REGISTERED_PACK -> PUBLISH -> OPEN_DRAFT_PR`

Registration reads and validates the Web implementation pack, checkpoints its exact archive/pack identity, registers through Phase 9, persists the exact selected registration, then completes the attempt. Execution checkpoints the exact artifact/registration manifest pair and delegates only to the canonical Phase 10 constrained executor. Publication first re-attests the exact READY executor snapshot, checkpoints artifact + change-set digest, then delegates to the existing hardened publisher and accepts success only when the remote branch SHA equals the exact pushed commit.

Opening the Draft PR, packaging the Result Bundle and Web verdict/revision integration remain later roadmap surfaces. Phase 11 deliberately stops at `OPEN_DRAFT_PR`; it never merges.

## Persistence / portability

Canonical control state is `<state>/orchestration/runs/<task-id>/<task-bundle-sha256>/run-ledger.json`. Ledger and selected-artifact reads are bounded and reject symlink/non-regular/identity-changing files. Same-directory temporary writes are exclusive-created, `FileHandle.sync()`ed, renamed atomically, then parent-directory metadata is synced on non-Windows platforms. Node exposes `O_NOFOLLOW` only where supported; WCO keeps lstat/file-identity checks as the portable defense and does not claim a Windows directory-entry fsync guarantee Node does not expose portably.

## Performance / token / session negative requirements

Upstream openai/codex issues #35385, #19517, #22037, #22411 and #30932 report rollout persistence divergence, expensive/global session scans, idle CPU from full thread deserialization and pathological history growth/OOM. WCO therefore keeps its own bounded checkpoint state, does not require `thread/list`/global resume scans for status or recovery, references immutable hashes instead of copying large evidence into the hot ledger, reuses sealed request identity across retries, and treats Codex thread IDs as compatibility handles rather than durable authority. WCO does not patch OpenAI internals.

Default retry policy starts at 1s, doubles per durable attempt, applies deterministic 75–125% jitter, caps at 60s, opens the circuit after five consecutive failures for 120s, allows four attempts per transition and 24 total attempts. Worker pools and queues remain bounded with explicit backpressure.

## User surface

`wco-control next --run-id <id> --state-dir <state> [--json]`

`wco-control status --run-id <id> --state-dir <state> [--json]`

`wco-control pause|resume --run-id <id> --state-dir <state> [--json]`

`wco-control doctor --run-id <id> --state-dir <state> --config <config> [--json]`

`wco-control continue --run-id <id> --state-dir <state> --config <config> [--web-pack <zip>] [--max-transitions 1..32] [--json]`

## Release gate

`npm run phase11:release-gate`

The gate covers typecheck, frozen Phase 9/10 tests, Phase 11 tests, the complete unit/fake suite, Phase 8 E2E, build and compiled CLI integration. Native Windows/WSL Codex authentication/runtime behavior remains a later local compatibility gate; GitHub fake/deterministic tests must not pretend to prove it.
