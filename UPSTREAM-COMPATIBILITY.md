# Upstream Compatibility and Negative Requirements

WCO integrates with upstream software without assuming that upstream behavior is perfect or permanent. This file separates problems WCO should mitigate from problems owned by the OpenAI Codex runtime/app that WCO should only detect/document.

## Classification

- **WCO/bridge-applicable:** browser/session/relay/orchestration/resource problem that WCO can prevent, shield, detect or recover from. Must become a requirement/test where practical.
- **Compatibility-only:** problem inside OpenAI Codex app/CLI/agent internals. WCO may detect version/capability, surface diagnostics or fail safely, but does not patch/fork OpenAI internals.
- **External runtime:** dependency/runtime problem (for example Bun). WCO avoids depending on it where possible and provides diagnostics/backoff rather than restart storms.

## codex-chatgpt-web issue matrix

| Upstream | Observation | WCO classification | WCO requirement |
| --- | --- | --- | --- |
| issue #49 | User reported five sessions appearing frozen/slow. Maintainer's controlled test did not reproduce a 5× slowdown and v2.0.0 reports fixes for stale tab ownership, premature completion and browser-turn cleanup; five Web turns remain a hard limit. | WCO/bridge-applicable | Explicit configurable concurrency cap, per-turn ownership, backpressure, cleanup/TTL, workload benchmark. Do not assume either “5 always freezes” or “5 is always safe”. |
| issue #51 | Windows launcher log shows browser initialization abort and bundled Bun 1.3.14 crash/restart. | External runtime + WCO/bridge-applicable recovery | WCO remains Node-based, detects unhealthy bridge, bounded restart/backoff, no hot restart loop, diagnostics preserve crash reason. |
| issue #52 | Bun illegal-instruction crash during launcher setup on Windows CPU without expected instruction support. | External runtime | Do not make WCO depend on the bridge's bundled Bun. `wco doctor` checks actual local runtime/architecture before native mode. |
| issue #69 | Cold Temporary Chat + High effort can fail while a warm-up Instant turn may make later High succeed. | WCO/bridge-applicable | Native capability/health probe, typed cold-start failure, bounded retry/warm-up policy only when evidence says it is safe; retry must not silently burn mission token budget. |
| issue #72 | Bridge can advertise nonexistent `exec_command` for `code_mode_only`; turn may complete with no brokered tool call. | WCO/bridge-applicable | Discover actual tool registry/capabilities per bound turn; never hard-code a missing command tool; “completed with zero expected broker activity” is a typed failure, not success. |

Upstream issue links:

- https://github.com/miuuyy/codex-chatgpt-web/issues/49
- https://github.com/miuuyy/codex-chatgpt-web/issues/51
- https://github.com/miuuyy/codex-chatgpt-web/issues/52
- https://github.com/miuuyy/codex-chatgpt-web/issues/69
- https://github.com/miuuyy/codex-chatgpt-web/issues/72

This matrix is intentionally evidence-sensitive. If upstream closes/fixes an issue, WCO retains the regression requirement when it represents a generally useful safety/performance invariant, but documentation must not claim the old upstream version is still broken.

## Required Phase 12 adapter posture

The native adapter must expose a capability snapshot, not assumptions:

```text
bridge version
Codex version
transport mode
tool mode
advertised tool registry
command gateway (if any)
MCP capability
browser/session health
active turn/session counts
```

The snapshot is bounded and versioned. A capability change invalidates the current binding before another mutating turn.

## Session lifecycle

WCO owns mission/task state independently from browser tabs and ChatGPT sessions. Browser/session identity is transport state only.

Therefore:

- stale/lost tab cannot silently reassign a mission;
- turn completion is not sufficient evidence if a required tool/broker action never occurred;
- disconnect must preserve the sealed request/hash so a retry cannot accidentally execute a different prompt;
- cleanup is explicit and observable;
- concurrency is bounded/backpressured;
- one task cannot consume another task's stream/MCP channel.

## Codex/OpenAI-owned failures

For failures demonstrably inside the OpenAI Codex app/CLI/agent itself, WCO follows this rule:

```text
detect / report / bind version / safe retry if contract allows
        ≠
patch or emulate Codex internals
```

Examples of compatibility handling:

- unsupported Codex version → typed compatibility block;
- Codex process exits/crashes → durable WCO checkpoint + diagnostic receipt;
- upstream behavior changes → capability rediscovery;
- model/tool behavior unavailable → escalate/stop according to policy.

WCO does not promise to correct model quality, Codex internal CPU behavior, proprietary app renderer behavior, or bugs that require changing OpenAI's binary/service.

## Update policy

Before v1.0 release:

1. refresh this matrix against the then-current bridge release/issues;
2. mark each applicable item `covered`, `mitigated`, `local-verification-required`, or `not-applicable`;
3. link executable WCO test IDs;
4. run native compatibility/performance smoke checks from `LOCAL-FINAL-CHECKLIST.md`.
