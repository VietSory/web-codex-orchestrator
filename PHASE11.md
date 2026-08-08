# Phase 11 — Durable Orchestration

## Goal

Phase 11 turns the existing Phase 3–10 primitives into a durable control plane that can survive process restart, transport failures and operator pauses without requiring the user to remember the next low-level command.

```text
canonical run + registered artifacts
        ↓
run-ledger.json
        ↓
plan one exact transition
        ↓
seal request hash + checkpoint attempt
        ↓
execute/adopt one idempotent phase driver
        ↓
checkpoint exact result
        ↓
next transition / wait / human decision
```

The first Phase 11 release milestone is **Verified Task Autopilot / Single-PR Core Alpha**. Merge remains human-owned.

## Non-negotiable invariants

1. Durable mission/task state belongs to WCO, not a browser tab, Codex thread or chat session.
2. Every external/model/network/mutating transition is checkpointed **before** the call with an exact request SHA-256 and deterministic attempt ID.
3. A crash/restart may adopt an already-existing canonical phase result only when it matches the sealed request/authority. It must not blindly repeat a side effect.
4. Retry budgets, token/turn budgets and consecutive failure/circuit state persist across process restart.
5. Retryable transport failures use bounded exponential backoff with jitter/cap. No hot restart/retry loop.
6. Derived logs/history/caches never authorize a transition. Authorization comes from canonical phase receipts/artifacts and persisted budget/counter state.
7. History is bounded. The hot ledger stores a hash-chained event tail plus compaction anchor, not unbounded raw logs/evidence.
8. Repeated identical diagnostics are deduplicated with a counter.
9. Worker concurrency is bounded and backpressured. Queue overflow fails explicitly instead of spawning more workers.
10. Pause prevents new transitions but does not corrupt/erase an already sealed checkpoint. Resume continues from canonical state.
11. Status/next/doctor paths are cheap and do not initialize Codex/browser/network work unless explicitly requested.
12. Late results from an expired/replaced attempt cannot advance the ledger.
13. Merge, dangerous data operations, breaking product decisions and other human-policy gates remain human decisions.

## Durable ledger

Canonical per-run state:

```text
<state>/orchestration/runs/<task-id>/<task-bundle-sha256>/run-ledger.json
```

The ledger contains only bounded hot orchestration state:

- exact run/task identity;
- current/next transition;
- persisted per-transition attempt counters;
- current sealed attempt identity/hash;
- total/model/token/time budgets;
- retry/circuit state;
- deduplicated diagnostics;
- bounded hash-chained event tail with compaction anchor.

Raw verifier/reviewer/Result Bundle evidence remains in its phase-specific immutable stores and is referenced by hashes rather than copied into the ledger.

## Retry / circuit policy

Retry is a control-plane decision, not a Codex/browser-internal loop.

Default policy begins conservatively:

```text
base delay        1s
exponential       2^(attempt-1)
deterministic jitter 75%..125%
max delay         60s
consecutive failures before circuit open 5
circuit open      120s
per-transition attempts 4
total attempts    24
```

Defaults are configurable later, but all bounds remain finite. Retry classification is typed; terminal authority/security/validation failures do not become transport retries.

The retry payload hash is stable. A transport retry may create a fresh transport/session attempt, but it does not silently regenerate a different task/context payload.

## Concurrency / resource pools

Separate bounded pools are required for:

- Web/browser transport turns;
- Codex/model review turns;
- deterministic verifier processes;
- Git/network mutations;
- mission runnable tasks (later Phase 15).

A configured maximum is a safety/performance policy, not a claim that one fixed number is optimal for every machine. Native benchmarks in Phase 16 determine recommended platform defaults.

## UX commands

Phase 11 will expose a control-plane surface centered on intent rather than phase trivia:

```text
wco-control continue
wco-control next
wco-control status
wco-control doctor
wco-control pause
wco-control resume
```

`continue` performs at most the next safe transition(s) permitted by durable authority/budgets until it reaches wait-human/wait-Web/block/complete. `status` and `next` are read-only. `doctor` reports bounded capability/config/runtime/state health.

The long-term Phase 12 native `/wco ...` interface will wrap this control plane rather than duplicate its state machine.

## Performance / token / upstream requirements

Phase 11 implements the project-wide `PERFORMANCE.md` and `UPSTREAM-COMPATIBILITY.md` rules:

- no whole-history deserialization for status;
- no routine screenshots in health polling;
- content/evidence referenced by immutable hash;
- sealed request reuse on retry;
- token/turn/retry usage persisted;
- bounded concurrency/backpressure;
- idle/failed transport resources are not treated as durable task state;
- reconnect/cold-start/tool-registry problems in bridge/Codex integrations become typed transition failures with checkpointed retry policy;
- OpenAI Codex internals are not patched.

## Exit criteria

- bounded/no-follow durable ledger and lock/state confinement;
- sealed request/attempt identity before external work;
- exact result adoption/idempotency contract;
- persisted retry/backoff/circuit/budget state;
- pause/resume;
- bounded resource pools/backpressure;
- planner/driver integration for the single-PR lifecycle;
- cheap status/next/doctor;
- compiled CLI;
- crash/restart/late-result/retry-budget/concurrency/token regressions;
- exact-head release gate + strict maintainer audit.
