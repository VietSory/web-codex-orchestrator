# ADR 0004 — One-authorization local ChatGPT Codex transport

Status: **accepted and implemented on the Draft branch; release default remains gated on exact-head CI and live one-authorization acceptance**.
Decision date: 2026-08-13
Supersedes ADR 0003 for the normal-user transport decision. It does not authorize merge, release or a production-readiness claim before the release gate below passes.

## Frozen normal-user contract

WCO must preserve this experience:

```text
npm install -g web-codex-orchestrator
cd /path/to/project
wco

first use when authorization is missing:
  one official ChatGPT browser authorization

after that:
  wco
  > goal
```

The normal user must not configure or copy/paste a Cloudflare account, VPS, domain, DNS record, relay URL, tunnel ID, API key, bearer secret, MCP App, Workspace Agent, trigger ID, OAuth client, browser cookie, browser profile, or public localhost endpoint.

WCO remains single-user and local-first. Repository state, exact-read receipts, context cache, orchestration state, verifier state, repair generations, Git worktrees and WCO-owned credentials remain on the user's machine. GitHub and OpenAI/ChatGPT are external services only because the requested workflow already uses them.

## Decision

Use WCO's pinned bundled official Codex runtime as the normal ChatGPT-authenticated semantic transport.

A fresh normal-user trusted config intentionally contains no `web_bridge` field. Absence selects the local ChatGPT/Codex transport; explicit `web_bridge` values are compatibility/operator overrides only.

The current implementation delegates authorization to the provider-owned official Codex login surface (`codex login`, with `codex login status` for preflight). The runtime owns Sign in with ChatGPT, browser OAuth handoff, credential persistence and refresh. WCO does not read or copy the runtime's stored provider token, does not extract ChatGPT cookies/session state and does not require an OpenAI API key for the normal path.

An app-server login adapter may be adopted later if it preserves the same authority and UX contract, but app-server-specific RPCs are not a prerequisite or claimed capability of this release candidate.

If provider authorization completes but the runtime remains unusable because of an upstream account/scope/provider fault, WCO fails closed with a provider-auth diagnostic and offers only the same official ChatGPT reauthorization path. It must not redirect the normal user to API-key, tunnel, relay, hosted-service or manual-token configuration.

Semantic author/reviewer turns execute through the official Codex SDK/runtime with WCO-controlled structured output. Repository context remains mediated by the existing `WebBridge` protocol and bounded exact WCO reads rather than granting semantic turns repository mutation authority.

The authority split is:

```text
user goal
   |
   v
WCO orchestrator (local)
   |
   +--> ChatGPT-authenticated Codex semantic thread
   |       - architecture / repository analysis / review
   |       - structured bounded output
   |       - read-only, no approval, no network/Web-search capability
   |       - no repository mutation authority
   |
   +--> WCO exact repository read service
   |       - summary/tree/search/bounded read
   |       - exact base + digest receipts
   |
   +--> Harness-side Codex implementation planner
   |       - read-only proposal bound to canonical job/run
   |       - no direct mutation/Git/publish authority
   |
   +--> Harness / executor / verifier
           - only worktree mutation authority
           - verifier/test execution
           - repair adoption
           - Git/Draft PR lifecycle

human remains the only merge/release authority
```

## Official runtime capabilities used now

The release candidate reuses the bundled official Codex CLI/SDK for provider login, structured output, resumable SDK threads and sandbox controls. WCO keeps provider thread IDs as durable continuity metadata, while all workflow authority remains in WCO-owned validated state and receipts.

The common `AgentClient` boundary intentionally requires `network_access=false`, `live_web_search=false` and `cached_web_search=false`, and the SDK adapter enforces `webSearchMode: "disabled"`. Therefore live external Web research is **not** a release capability of ADR 0004 today.

A future semantic-only adapter may add official provider Web search after a separate safety/design review. Such an adapter must not widen Harness, filesystem, shell, Git, credential or shipment authority, and externally derived claims would require explicit source/evidence handling.

Provider/app-server command-execution primitives are outside the semantic surface. WCO must never use an unsandboxed shell-command RPC as part of this transport; Harness remains the command boundary.

## Provider boundary

The internal transport identity is `chatgpt_codex`; normal users do not write that mode or its credentials to config.

Semantic provider output is a shallow closed envelope and is parsed into only phase-appropriate WCO authority. During authoring, the provider can request bounded repository context or seal a contract; it cannot submit implementation authority. After canonical preparation, a separate Harness-side implementation planner returns a closed `WebImplementationSubmission`, which is validated again and bound to exact `job_id`/`run_id` before mutation. Review output is separately parsed as a WCO verdict.

This separation keeps provider/runtime evolution outside the WCO authority model.

## Why not automate chatgpt.com as the release default?

Browser-agent projects provide useful engineering ideas such as persistent-session recovery, accessibility-tree targeting, deterministic action caching, fail-closed selector drift and evidence capture. WCO may reuse those general resilience patterns where appropriate.

They are not the normal ChatGPT transport. WCO will not make DOM/output scraping, cookie extraction, private ChatGPT endpoints or UI automation a release requirement. This avoids coupling correctness to a changing UI and avoids requiring WCO to programmatically extract ChatGPT Service output through the website.

## Why not Secure MCP Tunnel / managed relay as the default?

Both can remain advanced compatibility/operator profiles, but their setup violates the frozen one-authorization contract for a single-user local tool when they require provider/operator configuration beyond the user's ChatGPT authorization.

No failure in the normal local transport may silently fall back to tunnel, relay, managed hosting, browser scraping or manual credentials.

## Semantic execution rules

1. `WebBridge` remains the transport abstraction; transport never becomes workflow authority.
2. Semantic turns receive exact intent/repository identity but no direct worktree mutation authority.
3. Repository inspection uses WCO's bounded `summary`, `tree`, `search` and exact file/byte-region read contracts.
4. Exact-base read coverage and SHA-256 receipts remain mandatory where bounded replacement/deletion authority requires them.
5. Current release semantic and implementation-planning turns remain read-only, no-approval, no-network and Web-search-disabled.
6. Structured outputs are locally parsed against phase-specific WCO schemas before they become authority.
7. The implementation proposal is accepted only after canonical prepared-run binding and exact `job_id`/`run_id` validation.
8. Harness remains the sole repository mutation and deterministic verification authority.
9. PAIR and AUTOPILOT preserve bounded safety/recovery semantics, same-Draft-PR repair behavior and human-only merge/release boundary.
10. Independent review uses separately created review state/thread identity where required. Final intent review is bound to exact durable intent/run/result evidence rather than trusting ambient provider conversation state.
11. Authentication failure is fail-closed. The only normal-user recovery is the official ChatGPT authorization flow; no manual secret or infrastructure setup is offered.
12. No normal local failure may automatically activate a compatibility transport.

## Recovery and durability requirements

Semantic thread IDs and their WCO role/bindings may be stored in owner-protected local WCO state. They are not mutation authority.

Provider-turn reservation/idempotency must prevent an ambiguous crash from silently creating a second authority-bearing implementation proposal. Completed authority is replayed from durable WCO state; ambiguous non-replayable provider work fails closed.

A crash/restart must not require a new user configuration step. WCO resumes or deterministically reconstructs workflow context from sealed local evidence. If the official runtime reports the ChatGPT credential revoked/expired beyond silent refresh, WCO may request the same browser authorization again.

Provider lifecycle is not trusted blindly: semantic turns require bounded execution, exact thread/job/run bindings and fail-closed handling for malformed or stale output.

## Release gate

ADR 0004 becomes the shipped normal-user default only after all of the following are proven on the exact PR head:

```text
normal-user authorization interaction    = one provider-owned ChatGPT flow
manual credential/ID/endpoint inputs      = 0
Cloudflare/VPS/domain/DNS requirements    = 0
tunnel/MCP/App/Agent setup requirements   = 0
per-task browser interactions             = 0
browser DOM/output scraping               = 0
repository mutation outside Harness       = 0
force push / auto merge / release         = 0
crash/restart requires reconfiguration    = 0
PAIR and AUTOPILOT deterministic suites   = PASS
clean packed install                       = PASS
zero-config daily-user contract            = PASS
real local authorization + task journey    = PASS
restart/recovery local acceptance          = PASS
```

Deterministic qualification includes:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:contract
```

Until deterministic exact-head gates pass and the real local acceptance is completed, the PR remains Draft and must not claim normal-user production readiness.

## Compatibility profiles

The following may remain explicit advanced/debug compatibility modes, but are not normal-user requirements and must never be selected as a silent fallback:

- `web_native_mcp`
- `managed_actions`
- `personal_actions`
- `actions_relay`
- `manual_file`

The local `chatgpt_codex` transport is selected implicitly by absence of a `web_bridge` override rather than by silently changing the semantics of a legacy profile.