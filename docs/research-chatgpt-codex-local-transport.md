# Research — local one-authorization semantic transport

Research date: 2026-08-13

This note records the research inputs behind ADR 0004. It is not a substitute for exact-head validation.

## Constraint

Normal WCO usage must be local-first and single-user. The user authorizes ChatGPT once and configures nothing else. No Cloudflare, VPS, domain, DNS, relay, tunnel, API key, bearer secret, MCP App, Workspace Agent, copied provider ID, browser cookie/profile, or public workstation endpoint may be a normal-user prerequisite.

## OpenAI Codex runtime

The official Codex app-server exposes ChatGPT browser authorization, persisted/resumable threads, thread forks, context compaction and detached review threads. The TypeScript SDK exposes structured output, read-only sandbox mode, approval policy controls and web-search modes. WCO already ships pinned `@openai/codex` and `@openai/codex-sdk`, so using that runtime avoids a second browser/session stack and avoids asking the user for an API key.

WCO should initially reuse its existing hardened `CodexSdkAgentClient`, then keep thread/session bindings engine-neutral so an app-server adapter can later use fork/compaction/review primitives directly.

## Durable-agent workflow research

LangGraph's persistence model reinforces a pattern WCO already uses: checkpoint each durable step, give each execution a stable thread identity, persist writes before advancing, and resume from the last completed step rather than blindly re-running earlier work. WCO should reuse the pattern, not add LangGraph as a hosted dependency.

The practical WCO rule is: persist semantic turn identity/output plus its input/idempotency digest before advancing the local orchestration cursor. A resumed job replays completed semantic outputs from local state and only invokes a model for an uncompleted semantic step.

## Browser-agent projects

Modern browser-agent projects contribute useful ideas: persistent-session recovery, accessibility-tree targeting, deterministic action caching, selector/action self-healing, explicit evidence and fail-closed drift handling.

Those ideas may inform diagnostics or a non-default experimental adapter, but browser automation is not the release transport. The normal implementation must not scrape ChatGPT DOM/output, copy browser cookies, call private ChatGPT endpoints or depend on the ChatGPT UI shape.

## Context optimization

Keep WCO's existing progressive exact-base context protocol instead of exposing an entire repository to the semantic transport:

1. repository summary;
2. bounded tree;
3. bounded search;
4. exact full-file or byte-region reads;
5. content digest references for immutable repeated context;
6. diff/result deltas for review.

A future local symbol index may improve step 3 using syntax-aware symbol references, but it must remain disposable derived context; exact Git reads and receipts remain authoritative.

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
7. change first-run default only after CI, packed-user and live one-authorization acceptance pass;
8. retain managed/native/relay/manual transports as explicit compatibility profiles only.
