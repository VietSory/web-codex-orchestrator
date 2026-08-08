# Upstream Compatibility and Negative Requirements

WCO integrates with upstream software without assuming that upstream behavior is perfect or permanent. This file separates problems WCO should mitigate from problems owned by the OpenAI Codex runtime/app that WCO should only detect/document.

## Classification

- **WCO/bridge-applicable:** browser/session/relay/orchestration/resource problem that WCO can prevent, shield, detect or recover from. Must become a requirement/test where practical.
- **Compatibility-only:** problem inside OpenAI Codex app/CLI/agent internals. WCO may detect version/capability, surface diagnostics or fail safely, but does not patch/fork OpenAI internals.
- **External runtime:** dependency/runtime problem. WCO avoids depending on it where possible and provides diagnostics/backoff rather than restart storms.

## codex-chatgpt-web issue matrix

| Upstream | Observation | WCO classification | WCO requirement |
| --- | --- | --- | --- |
| issue #49 | A user reported five sessions appearing frozen. The maintainer could not reproduce a 5× slowdown; v2.0.0 reports fixes for stale tab ownership, premature completion and cleanup, retains five as a hard safety limit, and showed controlled 5-turn completion in roughly the same wall-time range as one turn. | WCO/bridge-applicable | Do **not** encode “parallel is always bad” or “5 is always safe”. Discover bridge limit, keep an explicit configurable WCO pool/backpressure policy, isolate ownership, release idle sessions, and benchmark the real workload/machine before recommending concurrency. |
| issue/PR #54 | Failed browser turns could remain cached so each retry replayed the same dead failure while extending TTL. | WCO/bridge-applicable | Retry state is WCO-owned, bounded and typed. Retryable transport failure gets a fresh transport attempt while reusing the **same sealed request hash**; non-retryable failure is not hot-retried. Retry cannot extend a dead task forever. |
| issue/PR #62 | Routine browser screenshots/diagnostics contributed avoidable latency; proposed fix keeps normal diagnostics JSON-only and captures screenshots only for stalls/failures. | WCO/bridge-applicable performance | Normal health/status telemetry is compact structured text/JSON. Expensive screenshots/raw traces are failure/stall diagnostics, not polling payloads. |
| issue #69 | Cold Temporary Chat + High effort can fail while a warm-up Instant turn may make later High succeed. | WCO/bridge-applicable | Native capability/health probe; typed cold-start failure; bounded warm-up/retry only if adapter evidence says it is safe; every attempt consumes retry/token budget. |
| issue/PR #71 | Command relay/session handling needed truthful capability reporting, broker-owned deadlines, late-result cleanup and resumable-command checks. | WCO/bridge-applicable | Capability snapshot is authoritative for the adapter session; broker invocation has deadline/cancellation; late result cannot mutate a completed WCO transition; resumability depends on actually advertised capability. |
| issues #72/#73 | Tool-mode/namespace mismatches can advertise a command tool that does not exist or fail to discover a namespaced real tool; a turn may complete with no expected broker call. | WCO/bridge-applicable | Discover actual per-turn tool registry/gateway, never hard-code command-tool existence, and treat “completed but required broker activity absent” as typed failure rather than success. |
| issues #60/#68/#74 | ChatGPT UI/effort controls can drift so browser smoke tests fail even when basic page/composer state is present. | WCO/bridge-applicable | UI/bridge capability is discovered by smoke/health probe; unknown UI shape fails explicitly. WCO mission state survives the transport failure and does not reinterpret missing capability as approval. |
| issue #43 | Browser-side automatic compaction/context continuity can regress. | WCO/bridge-applicable design | Mission/task/project memory belongs to WCO durable state; browser/chat context is transport/cache only. A new session can reconstruct bounded context from project map, locks and receipts rather than requiring one immortal conversation. |
| issues #51/#52 | Windows launcher/Bun/runtime crashes or CPU/runtime incompatibility were reported around setup/startup. | External runtime + bridge recovery | WCO remains Node-based, `doctor` checks bridge/native health and architecture, restart has bounded backoff/circuit-breaker, and diagnostics preserve the original crash reason. WCO does not depend on the bridge's Bun runtime internally. |

This matrix is evidence-sensitive. If upstream closes/fixes an issue, WCO retains the regression requirement only when it is a generally useful reliability/performance invariant. Documentation must not claim a fixed upstream version remains broken.

## OpenAI Codex evidence refresh — 2026-08-08

Public upstream reports inspected for the Phase 16 freeze add these compatibility-only signals:

| Upstream | Reported behavior | WCO shield / regression requirement |
| --- | --- | --- |
| openai/codex #35385 | Rollout persistence errors during resume/fork can be discarded, allowing in-memory/on-disk divergence; the report reproduces with Codex CLI 0.145.0. | Durable WCO writes/recovery must fail visibly; WCO never infers successful persistence from an upstream resumed session. Canonical WCO receipts remain lifecycle authority. |
| openai/codex #30932 and related large-rollout reports | Extremely large rollout histories can cause multi-GB memory growth/OOM during resume. | WCO hot state is bounded/compacted. Control/status never requires whole-session deserialization. Context/project evidence is content-addressed and progressively assembled instead of replaying an immortal transcript. |
| openai/codex #25430 | Interactive resume picker can freeze with large session files while direct session-ID resume may work. | WCO never depends on the interactive picker for recovery or authority. A runtime thread ID, when used, is an explicit bounded transport handle only. |
| openai/codex #32061 | A resumed session may use the current config model/reasoning rather than the values recorded for that session. | Model and reasoning authority comes from trusted WCO configuration and is re-attested by WCO. Session metadata cannot silently override or define the execution contract. |

These issue reports are not treated as proof that every installation/version is affected. They justify defensive WCO invariants and local native smoke tests. WCO does not edit Codex rollout files, patch resume logic, fork the CLI/app, or emulate provider internals.

## OpenAI Codex-owned failures

Public Codex issues include reconnect loops, cache-hit inconsistency, session persistence/resume problems and usage-reporting/metering anomalies. These are useful **symptoms** for WCO orchestration design but are not code WCO can responsibly patch.

WCO policy:

```text
version/capability detect
→ seal request hash
→ checkpoint before external turn
→ bounded attempt/deadline
→ typed result/failure
→ bounded backoff/circuit-breaker when retryable
→ reuse sealed context/evidence where contract permits
```

WCO does not emulate or patch Codex networking, model quality, proprietary desktop renderer behavior, session rollout internals, server-side prompt caching or quota accounting.

## Native adapter posture

A native/bridge adapter must expose a bounded, versioned capability snapshot rather than assumptions:

```text
bridge version
Codex version
transport mode
tool mode
advertised tool registry / namespaces
command gateway (if any)
MCP capability
browser/session health
active/queued turn counts
supported effort/model routes
```

A capability change invalidates the current binding before another mutating turn.

## Session lifecycle

WCO owns mission/task state independently from browser tabs and ChatGPT/Codex sessions. Browser/session identity is transport state only.

Therefore:

- stale/lost tab cannot silently reassign a mission;
- turn completion is not sufficient evidence if required broker/tool activity never occurred;
- disconnect preserves the sealed request/hash so a retry cannot accidentally execute a different prompt;
- cleanup is explicit/observable;
- concurrency is bounded/backpressured, while the configured limit is benchmarked rather than guessed;
- one task cannot consume another task's stream/MCP channel;
- late results from an expired attempt cannot advance durable WCO state;
- persistence/resume failure does not erase WCO mission state;
- no lifecycle/status path scans all Codex sessions or loads arbitrary rollout history.

## Diagnostics posture

Normal status paths are cheap:

- bounded JSON summaries;
- counters/timings/attempt IDs/request hashes;
- no whole-session history deserialization;
- no screenshots unless a browser stall/failure makes them useful;
- raw traces/logs content-addressed or rotated separately from hot status state.

This reduces CPU/RAM pressure, token/context replay and user-facing diagnostic noise.

## Phase 16 coverage status

- bounded retry/backoff/rate-limit classification: **covered** by Phase 11/15/16 tests;
- bounded concurrency/backpressure: **covered** by Phase 11 resource-pool tests;
- bounded ledger/diagnostics/state: **covered** by Phase 11 durability/ledger tests;
- exact Web verdict and same-PR revision authority: **covered** by Phase 14/15 tests;
- session/history independence: **mitigated by architecture** and checked in maintainer audits;
- real Windows/WSL Codex sandbox/runtime and `codex-chatgpt-web` capability/latency behavior: **local-verification-required** in `LOCAL-FINAL-CHECKLIST.md`.

The Phase 16 freeze retains generally useful negative requirements even if a future upstream release fixes the motivating issue.
