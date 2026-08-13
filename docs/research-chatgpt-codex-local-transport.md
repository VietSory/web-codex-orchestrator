# Research — local one-authorization semantic transport

Research date: 2026-08-13

This note records the research inputs behind ADR 0004. It is not a substitute for exact-head validation.

## Constraint

Normal WCO usage must be local-first and single-user. The user authorizes ChatGPT once and configures nothing else. No Cloudflare, VPS, domain, DNS, relay, tunnel, API key, bearer secret, MCP App, Workspace Agent, copied provider ID, browser cookie/profile, or public workstation endpoint may be a normal-user prerequisite.

## OpenAI Codex runtime

The official Codex app-server exposes ChatGPT browser authorization, persisted/resumable threads, thread forks, context compaction and detached review threads. The TypeScript SDK exposes structured output, read-only sandbox mode, approval policy controls and web-search modes. WCO already ships pinned `@openai/codex` and `@openai/codex-sdk`, so using that runtime avoids a second browser/session stack and avoids asking the user for an API key.

WCO should initially reuse its existing hardened `CodexSdkAgentClient`, then keep thread/session bindings engine-neutral so an app-server adapter can later use fork/compaction/review primitives directly.

### App-server primitives WCO may use

- `account/login/start` with ChatGPT browser authorization;
- `account/read` / account update state for readiness;
- `thread/start` and `thread/resume` for durable semantic conversations;
- `thread/fork` for a deliberately independent branch when appropriate;
- `thread/compact/start` for bounded long-running context;
- `review/start` with detached delivery when an independent review thread is useful;
- regular turn/item lifecycle events, bound to exact response/thread/turn identities.

### App-server primitives WCO must not expose to semantic transport

`thread/shellCommand` is explicitly unsuitable: the official app-server documentation states that it is user-initiated and runs unsandboxed with full access instead of inheriting the thread sandbox. WCO semantic transport must never call or surface it. Repository commands remain behind the existing closed WCO repository-read protocol and every mutation/verification command remains Harness-owned.

The app-server is also treated as an external state machine, not infallible local truth. Recent upstream bug reports show review lifecycle turn-ID disagreement and invalid model/reasoning combinations that can hang without events. WCO therefore needs explicit timeouts, model/effort prevalidation where possible, exact response identity binding and fail-closed handling for inconsistent lifecycle events.

## Durable-agent workflow research

LangGraph's persistence model reinforces a pattern WCO already uses: checkpoint each durable step, give each execution a stable thread identity, persist writes before advancing, and resume from the last completed step rather than blindly re-running earlier work. WCO should reuse the pattern, not add LangGraph as a hosted dependency.

The practical WCO rule is: persist semantic turn identity/output plus its input/idempotency digest before advancing the local orchestration cursor. A resumed job replays completed semantic outputs from local state and only invokes a model for an uncompleted semantic step.

## Browser-agent projects

Modern browser-agent projects contribute useful ideas: persistent-session recovery, accessibility-tree targeting, deterministic action caching, selector/action self-healing, explicit evidence and fail-closed drift handling.

Those ideas may inform diagnostics or a non-default experimental adapter, but browser automation is not the release transport. The normal implementation must not scrape ChatGPT DOM/output, copy browser cookies, call private ChatGPT endpoints or depend on the ChatGPT UI shape.

This is both a reliability and release concern: the current OpenAI Terms of Use prohibit automatically or programmatically extracting data or Output from the consumer Services. WCO therefore uses official Codex/runtime surfaces rather than treating the ChatGPT website as a scrape target.

## Context optimization

Keep WCO's existing progressive exact-base context protocol instead of exposing an entire repository to the semantic transport:

1. repository summary;
2. bounded tree;
3. bounded search;
4. exact full-file or byte-region reads;
5. content digest references for immutable repeated context;
6. diff/result deltas for review.

### 2026 repository-localization findings

Recent repository-exploration research strengthens this design but suggests a better retrieval layer in front of exact reads:

- SWE-Explore evaluates exploration independently from final repair and measures relevant-region coverage, ranking quality and context efficiency under a fixed line budget. WCO should add equivalent deterministic localization metrics instead of benchmarking bytes/tokens alone.
- Retrieval-oriented code representation research reports that role-aware file summaries can substantially improve localization at far smaller representation footprint than raw source. WCO should add disposable local role summaries as retrieval hints, keyed by exact file digest.
- Aider's repo-map implementation remains a useful practical reference: tree-sitter definitions/references plus graph ranking produce a compact token-aware repository map.
- Structural multi-file localization research warns that forced multi-agent consultation can raise token cost without consistent benefit. WCO should not add an always-on explorer swarm. Keep one durable semantic author by default; parallel/domain exploration is only worth revisiting if a measured benchmark shows a net gain for large cross-subsystem tasks.

### Proposed local retrieval stack

```text
exact Git base
   |
   +--> disposable role summary cache     (digest keyed)
   +--> disposable symbol/reference map   (Tree-sitter/structural parser)
   +--> relevance/ranking layer           (goal + mentioned symbols + graph rank)
   |
   v
bounded candidate regions
   |
   v
existing exact WCO read command
   |
   v
SHA-backed authoritative context
```

The derived summary/symbol/ranking layers are advisory only. Cache corruption, unsupported language parsing or low graph coverage causes them to be discarded or bypassed; exact Git reads remain authoritative. No vector database, cloud index or user setup is required.

A future local symbol index may improve bounded search using syntax-aware symbol references. Tree-sitter and ast-grep are useful implementation references for incremental parsing and structural search; neither should become mutation authority.

## Review topology

Use three durable semantic identities:

- author/original-intent thread;
- independent code-review thread;
- original-author final-intent review continuation.

Independent review must not inherit hidden author reasoning. Final-intent review must be bound to the original author intent/thread or an exact durable reconstruction after failure.

## Recommended implementation order

1. introduce `chatgpt_codex` as a distinct transport profile;
2. add a closed provider-output envelope and revalidate nested payloads with existing WCO schemas;
3. add one-time ChatGPT authorization through the bundled official runtime;
4. implement local durable semantic thread bindings and idempotent turn receipts;
5. connect authoring to the existing exact repository-command loop;
6. connect independent/final review without granting mutation authority;
7. add app-server-specific timeout/identity/model guards before relying on fork/compact/detached-review primitives;
8. add digest-keyed role summaries/symbol-map retrieval plus SWE-Explore-style localization benchmarks;
9. change first-run default only after CI, packed-user and live one-authorization acceptance pass;
10. retain managed/native/relay/manual transports as explicit compatibility profiles only.
