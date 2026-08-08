# WCO Performance, Resource and Token Architecture

Performance is a correctness property for WCO because unbounded CPU/RAM/process/session/state growth can turn retry/recovery into duplicated external work or make authority evidence unavailable. This document distinguishes executable v1 guarantees from future/native optimization opportunities.

## Implemented v1 guarantees

### Concurrency and backpressure

WCO does not fan out a run with unbounded `Promise.all` work. The durable controller serializes external transitions with a per-run execution fence, while lower layers retain their own operation/worktree locks. Retryable work is represented as durable `WAITING` state with `next_retry_at`; it is not implemented as a busy polling loop.

`continue` is bounded to 1..32 transitions per invocation and stops at external-input/human boundaries. A run cannot start a different sealed attempt while another attempt is still `STARTED`.

GitHub mutation work is therefore serialized by transition ownership. This follows GitHub's REST guidance to avoid concurrent requests and reduces secondary-rate-limit pressure.

### Retry behavior

Retry identity is deterministic: the transition kind plus canonical payload is SHA-256 sealed before external work. Retryable transport failures reuse that identity instead of regenerating a different request.

The controller has bounded total-attempt, per-transition, elapsed-time and consecutive-failure budgets. Retry delay is deterministic exponential backoff with jitter. For GitHub rate-limit failures, WCO uses a valid `Retry-After` delay when supplied, uses `X-RateLimit-Reset` only when `X-RateLimit-Remaining` is `0`, and otherwise applies the documented one-minute secondary-limit fallback when GitHub identifies a secondary limit. Applicable waits become a bounded minimum delay; if the required wait exceeds the remaining orchestration elapsed budget, WCO blocks rather than sleeping past its budget.

Authority/policy failures are terminal and are not converted into retries to make progress appear green.

### Process and output bounds

WCO process execution uses explicit executable/argument vectors, deadlines/cancellation and bounded stdout/stderr retention. Shell interpolation is not the default execution model. Where the runtime exposes only parent-process cancellation, WCO documents that boundary instead of claiming guaranteed descendant/process-tree termination on every platform.

The GitHub REST client retains at most 1 MiB of response body. Chunks are copied into exact bounded buffers, accumulated with a byte counter and concatenated once, avoiding repeated whole-buffer copies or retention of a larger stream backing buffer. Error diagnostics are separately bounded and the configured token is redacted from retained error text.

Revision state/evidence reads are bounded and identity-stable. Revision canonical artifacts are capped at 2 MiB. Mutable revision receipts use synced temporary writes plus atomic rename; immutable artifacts use synced temporary bytes plus atomic hard-link installation and exact-byte idempotency.

### Durable state growth

The orchestration ledger keeps bounded recent events and diagnostics rather than raw unbounded process/model transcripts. Canonical evidence is stored in purpose-specific receipts/artifacts. Status/next reads derive lifecycle from bounded receipts and do not deserialize Codex/ChatGPT session history.

Crash recovery adopts only exact terminal canonical evidence. In particular, revision recovery does not start another model turn merely because the outer process restarted: an exact `RESULT_READY` Phase 8 receipt must already exist before the outer ledger can adopt it.

### Session lifecycle

Codex/browser/session identifiers are transport handles, not WCO authority. WCO persists direct handles where its adapter needs them and does not use an interactive/global resume picker to discover lifecycle state.

This shields WCO from a class of upstream session-list/history problems without modifying Codex internals. Public Codex issue reports have described large-session picker stalls, huge rollout OOM during resume, local index/session visibility divergence and persistence failures. WCO's response is bounded independent state plus exact receipt recovery, not a private fork of Codex.

### Token accounting

The outer orchestration ledger exactly records the model-turn/input/output usage exposed by completed Phase 8 revision receipts. A new model-bearing transition is refused when the corresponding outer budget is already exhausted, and completing a revision that crosses the outer budget blocks subsequent automatic work.

The frozen Phase 10 executor receipt does not expose token counters. WCO therefore does not fabricate usage and does not claim that the outer ledger measures every lower-layer reviewer/verifier token. Those lower layers remain governed by their own bounded agent/reviewer/verifier policies.

Cached-input counters are retained when a lower-level runtime exposes them, but a cache hit is never authority and cache telemetry is not required for correctness.

## Context assembly and reuse

WCO v1 reuses immutable/hash-bound artifacts that already exist in the protocol: task bundle identity, registered implementation-pack identity, operation/evidence digests, sealed transition requests, Result Bundle manifests and review/revision receipts. Retry/recovery references those identities instead of replaying whole browser/model transcripts.

Model-facing work should receive the narrow authority/evidence required by the current stage rather than a complete historical transcript. Reviewer roles receive the approved change/evidence surface, not an implementation conversation as authority.

### Project-map boundary

The repository currently does **not** contain a separate repository-wide project-map/index cache subsystem with executable cache-hit/invalidation tests. Phase 16 therefore does not claim one exists.

If a future project-map/index is introduced, it must be derived/non-authoritative, keyed by immutable Git object/tree identity where practical, invalidated by source identity rather than wall-clock age, bounded in storage, and safely deletable/rebuildable. Until then, documentation must not use hypothetical project-map reuse as evidence for v1 performance.

## Native browser/bridge boundary

The current `codex-chatgpt-web` README describes fresh ChatGPT Temporary Chat browser turns, Codex-local task history as the task source of truth, serialized browser turns, explicit `doctor`/service/browser diagnostics and fail-closed behavior on UI/capability drift. It also currently documents managed background installation as macOS-only.

Those are upstream properties, not WCO guarantees. WCO treats bridge health/capability as transport compatibility, keeps its own durable mission/run state, and requires native/local verification before claiming a specific Windows/WSL bridge setup works.

## Performance evidence and regression expectations

GitHub CI is responsible for deterministic properties that WCO owns:

- concurrency/attempt fencing and retry-not-before behavior;
- bounded ledger/state diagnostics;
- bounded process and GitHub response retention;
- crash recovery without blind side-effect replay;
- exact primary/secondary GitHub retry behavior;
- token-budget preflight for model-bearing outer transitions;
- revision usage accounted once across crash adoption;
- immutable state idempotency/conflict rejection;
- status/next paths that do not start model work;
- install/package CLI metadata consistency.

Native/local testing is responsible for properties GitHub CI cannot honestly prove:

- actual Windows/WSL sandbox behavior;
- authenticated native Codex model/session behavior;
- browser/bridge capability and cleanup on the user's installed version;
- CPU/RAM/wall-time under the user's real machine/account/runtime;
- upstream bridge support or incompatibility on Windows/WSL.

Those checks are intentionally isolated in `LOCAL-FINAL-CHECKLIST.md`.

## Optimization rules for later work

Any future optimization must preserve these rules:

1. Never replace canonical authority with a cache.
2. Never widen concurrency merely because a machine appears idle.
3. Never replay an uncertain external mutation without reconciliation.
4. Prefer bounded incremental reads over loading complete histories/logs.
5. Prefer direct immutable identity over mutable timestamps for reusable derived context.
6. Keep stable context separate from dynamic task/error context when the model adapter allows it.
7. Measure native CPU/RAM/token/wall-time before changing default concurrency.
8. Keep diagnostics useful but bounded; raw traces/screenshots are failure artifacts, not normal polling state.

## References

- GitHub REST API rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub REST API best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Node.js file-system promises/FileHandle documentation: https://nodejs.org/api/fs.html
- OpenAI Codex issue #25430, large-session resume picker stall: https://github.com/openai/codex/issues/25430
- OpenAI Codex issue #30932, huge rollout resume OOM/SIGKILL report: https://github.com/openai/codex/issues/30932
- OpenAI Codex issue #32061, resume model/reasoning configuration report: https://github.com/openai/codex/issues/32061
- OpenAI Codex issue #35385, rollout persistence error report: https://github.com/openai/codex/issues/35385
- `codex-chatgpt-web` README/operations/limitations: https://github.com/miuuyy/codex-chatgpt-web
