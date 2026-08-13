# ADR 0004 — One-authorization local ChatGPT Codex transport

Status: **accepted for implementation; release default is gated on exact-head CI and live one-authorization acceptance**.
Decision date: 2026-08-13
Supersedes ADR 0003 for the normal-user transport choice once the implementation gate below passes.

## Frozen normal-user contract

WCO must preserve this exact experience:

```text
npm install -g web-codex-orchestrator
cd /path/to/project
wco

first use only:
  one official browser authorization for ChatGPT

after that:
  wco
  > goal
```

The normal user must not configure or copy/paste a Cloudflare account, VPS, domain, DNS record, relay URL, tunnel ID, API key, bearer secret, MCP App, Workspace Agent, trigger ID, OAuth client, browser cookie, browser profile, or public localhost endpoint.

WCO remains single-user and local-first. Repository state, exact-read receipts, context cache, orchestration state, verifier state, repair generations, Git worktrees and credentials owned by WCO remain on the user's machine. GitHub and OpenAI/ChatGPT are external services only because the requested workflow already uses them.

## Decision

Use WCO's pinned bundled official Codex runtime as the normal ChatGPT-authenticated semantic transport.

The preferred onboarding surface is the official app-server ChatGPT managed browser flow: WCO requests `account/login/start` with ChatGPT auth, opens the returned authorization URL, waits for the matching login-completed/account-updated state and then relies on Codex-managed persistence/refresh. WCO does not read or copy the runtime's stored tokens. The device-code flow is a provider-owned compatibility/recovery surface, not an additional normal-user setup step.

The runtime owns `Sign in with ChatGPT`, browser OAuth handoff, credential persistence and refresh. WCO does not implement ChatGPT cookie/session extraction and does not require an OpenAI API key for the normal path.

If provider authorization completes but the runtime remains unusable because of an upstream account/scope/provider fault, WCO fails closed with a provider-auth diagnostic and offers only the same official ChatGPT reauthorization path. It must not redirect the normal user to API-key, tunnel, relay, hosted-service or manual-token configuration.

Architect/reviewer turns execute through the official Codex SDK/runtime with WCO-controlled structured output. Repository access remains mediated by the existing `WebBridge` semantic protocol and exact bounded WCO reads rather than granting the semantic agent repository mutation authority.

The intended authority split is:

```text
user goal
   |
   v
WCO orchestrator (local)
   |
   +--> ChatGPT-authenticated Codex semantic thread
   |       - architect/research/review only
   |       - structured bounded output
   |       - no repository mutation authority
   |
   +--> WCO exact repository read service
   |       - summary/tree/search/bounded read
   |       - exact base + digest receipts
   |
   +--> Harness
           - only worktree mutation authority
           - verifier/test execution
           - repair adoption
           - Git/Draft PR lifecycle

human remains the only merge/release authority
```

## Official runtime capabilities to reuse

The local transport should reuse official persisted/resumable semantic threads, independent thread forks, context compaction, structured output, read-only sandbox controls and live web search instead of implementing a browser session manager. The existing TypeScript SDK is the first implementation surface because WCO already ships and tests it; the WebBridge state remains engine-neutral so a later app-server adapter can reuse the same authority protocol.

App-server command-execution primitives are outside the semantic surface. In particular WCO must never use or expose the user-initiated unsandboxed shell-command RPC as part of this transport; Harness remains the command boundary.

## Provider boundary

The dedicated mode name is `chatgpt_codex`. Provider structured output is intentionally a shallow closed envelope with protocol version, action kind and an opaque JSON payload string. WCO must parse the payload again through the existing closed repository-command, contract, implementation or verdict validator before it becomes semantic authority. This keeps provider/runtime evolution separate from WCO authority validation.

## Why not automate chatgpt.com as the release default?

Browser-agent projects provide useful engineering ideas such as persistent-session recovery, accessibility-tree targeting, deterministic action caching, fail-closed selector drift and evidence capture. WCO may reuse those general resilience patterns where appropriate.

They are not the normal ChatGPT transport. WCO will not make DOM/output scraping, cookie extraction, private ChatGPT endpoints or UI automation a release requirement. This avoids coupling correctness to a changing UI and avoids requiring WCO to programmatically extract ChatGPT Service output through the website.

## Why not Secure MCP Tunnel / managed relay as the default?

Both can remain advanced compatibility/operator profiles, but their setup violates the frozen one-authorization contract for a single-user local tool when they require provider/operator configuration beyond the user's ChatGPT authorization.

No failure in the normal local transport may silently fall back to tunnel, relay, managed hosting, browser scraping or manual credentials.

## Semantic execution rules

1. `WebBridge` remains the transport abstraction; transport never becomes workflow authority.
2. The semantic agent receives the exact user intent and repository identity but does not receive direct worktree write authority.
3. Repository inspection uses WCO's existing bounded `summary`, `tree`, `search` and exact file/byte-region read contracts where the WebBridge path is used.
4. Exact-base read coverage and SHA-256 receipts remain mandatory before bounded replacement/deletion authority is accepted.
5. Current/unstable technical claims may use live web search through an official runtime surface; primary/authoritative sources must be recorded in the sealed contract where relevant.
6. Structured outputs are locally parsed against WCO's closed schemas before they become authority.
7. Harness remains the sole repository mutation and deterministic verification authority.
8. PAIR and AUTOPILOT preserve their existing safety/recovery semantics, same-Draft-PR repair behavior and human-only merge/release boundary.
9. Independent review must use an independent thread/identity. Original-intent final review must remain bound to the original author intent/thread or an exact durable reconstruction of that identity after crash recovery.
10. Authentication failure is fail-closed. The only normal-user recovery is the official ChatGPT authorization flow; no manual secret or infrastructure setup is offered.

## Recovery and durability requirements

Semantic thread IDs and their WCO role/bindings may be stored in owner-protected local WCO state. They are not mutation authority.

A crash/restart must not require a new user configuration step. WCO must resume or deterministically reconstruct author/reviewer context from sealed local evidence. If the official runtime reports the ChatGPT credential revoked/expired beyond silent refresh, WCO may request the same single browser authorization again.

Provider lifecycle is not trusted blindly: semantic turns need explicit timeout budgets, exact response/thread/turn bindings and fail-closed handling when notifications disagree with the initiating response or when a model/reasoning combination is not known to be supported.

## Release gate

ADR 0004 becomes the shipped normal-user default only after all of the following pass on the exact PR head:

```text
first-run browser authorization surfaces = exactly 1
manual credential/ID/endpoint inputs      = 0
Cloudflare/VPS/domain/DNS requirements    = 0
tunnel/MCP/App/Agent setup requirements   = 0
per-task browser interactions             = 0
browser DOM/output scraping               = 0
repository mutation outside Harness       = 0
force push / auto merge / release         = 0
crash/restart requires reconfiguration    = 0
PAIR and AUTOPILOT safety suites          = PASS
packed-user journey                       = PASS
```

Until those gates pass, the branch must remain Draft and must not claim normal-user production readiness.

## Compatibility profiles

The following may remain explicit advanced/debug compatibility modes, but are not normal-user requirements and must never be selected as a silent fallback:

- `web_native_mcp`
- `managed_actions`
- `personal_actions`
- `actions_relay`
- `manual_file`

The implementation introduces a dedicated `chatgpt_codex` local transport mode rather than silently changing the semantics of one of those legacy profiles.
