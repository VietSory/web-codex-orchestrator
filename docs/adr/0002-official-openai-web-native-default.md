# ADR 0002: official OpenAI Web-native transport is the default

Status: accepted
Decision date: 2026-08-13
Supersedes: ADR 0001 as the default single-user transport

## Frozen user requirement

The normal WCO experience is:

```text
npm install -g web-codex-orchestrator
cd project
wco
```

On first run only, WCO may open official OpenAI/ChatGPT web configuration for authorization. After that, daily use is `wco` plus a goal. A normal user must not configure Cloudflare, ngrok, a VPS, a custom domain, DNS, AWS, external OAuth infrastructure, a public localhost endpoint, a relay secret, or manual bundles.

## Decision

Add `web_native_mcp` and make it the first-run/default Web transport.

```text
WCO local
  |
  | local durable semantic state
  v
WCO MCP stdio adapter
  ^
  | official tunnel-client; outbound HTTPS only
  |
OpenAI Secure MCP Tunnel
  |
private WCO ChatGPT MCP app
  |
private WCO Workspace Agent
  ^
  | official Workspace Agent trigger API
  |
WCO local
```

WCO owns the local lifecycle: capability checks, pinned/checksummed `openai/tunnel-client` bootstrap, tunnel start/stop/reconnect, durable task state, exact repository reads, recovery and diagnostics. The user does not operate `tunnel-client` directly during normal use.

One-time official OpenAI/ChatGPT setup remains a human authorization boundary. WCO opens only official OpenAI/ChatGPT configuration pages and asks for the resulting tunnel/Workspace-Agent identities and credentials through hidden local prompts. Secrets are stored only under owner-protected WCO credential storage and never in repository config, model context, Result Bundles or logs.

## MCP authority

The native MCP server exposes only bounded semantic and exact-read capabilities.

Read tools localize and read the sealed Git base. Three write-classified MCP tools submit semantic envelopes:

- `wco_submit_contract`
- `wco_submit_implementation`
- `wco_submit_review_verdict`

Those tools are non-destructive with respect to the repository. They append schema-validated semantic state only. They cannot edit the worktree, execute shell/Git, verify code, publish, merge, deploy or release. Harness remains the sole mutation authority.

Because OpenAI correctly treats semantic submissions as write tools, WCO does not falsely mark them read-only to bypass ChatGPT policy. For zero-click daily use, the one-time private Agent/App configuration should disable per-run confirmation for these specific non-destructive semantic submissions only when the workspace policy explicitly allows that setting.

## Web identity and context

Original Web-A continuity uses a stable author `conversation_key` across authoring and final intent review. PAIR independent Web-B review receives a distinct conversation identity. This preserves role separation without retransmitting an entire historical transcript through WCO.

Workspace Agent triggers use deterministic idempotency keys. A retried local transition may reuse the same provider-side trigger rather than intentionally creating another semantic call.

If a Workspace Agent run becomes `suspended`, fails, or completes without submitting the required WCO envelope/verdict, WCO stops with an explicit fail-closed diagnostic. It does not hang indefinitely and does not switch transports automatically.

## Capability boundary

Secure MCP Tunnel, full MCP write tools and Workspace Agent APIs are not available to every OpenAI plan/workspace. WCO must not fake availability or reverse-engineer private interfaces.

If the required official capability is absent, WCO reports `OPENAI_CAPABILITY_BLOCKED` (or a more specific Web-native error) and preserves all local/repository authority. It does not automatically recommend or deploy a third-party relay.

This means the frozen normal UX is available only on OpenAI workspaces that expose the official required capabilities. That limitation is explicit product truth, not something WCO may bypass with browser scraping or unsupported endpoints.

## Optional profiles retained

`personal_actions`, `actions_relay`, `managed_actions`, and `manual_file` remain explicit advanced/compatibility profiles. The Cloudflare reference adapter may remain packaged for users who deliberately select `personal_actions`, but it is neither default nor a release gate for Web-native WCO.

## Non-decisions

WCO does not:

- implement ChatGPT browser/DOM automation;
- scrape cookies or session state;
- call undocumented ChatGPT endpoints;
- expose the trusted workstation to public ingress;
- make a third-party cloud provider a normal dependency;
- grant MCP or Workspace Agent direct repository mutation authority;
- change PAIR into a Codex-reviewed flow;
- add a second Sol/Terra review call to AUTOPILOT;
- merge, mark ready, release or deploy without the human.

## Acceptance

A release candidate must prove deterministic/local behavior for:

- `web_native_mcp` as first-run default;
- closed MCP tool schemas and correct read/write annotations;
- owner-only native credential storage;
- pinned/checksummed official tunnel-client bootstrap;
- outbound-only tunnel command construction;
- Workspace Agent idempotency and capability denial;
- suspended/failed/completed-without-output fail-closed behavior;
- native doctor not requiring managed OAuth/device or third-party relay;
- PAIR model-review calls = 0;
- AUTOPILOT adaptive reviewer calls = exactly 1 by default;
- Harness model tokens = 0;
- same Draft PR and exact digest/head binding;
- human-only merge/release boundary.

Live Web-native acceptance may only be claimed when an authorized OpenAI workspace with the required official capabilities is available. Otherwise the release report must say `OPENAI_CAPABILITY_BLOCKED`; no fake hosted PASS is allowed.