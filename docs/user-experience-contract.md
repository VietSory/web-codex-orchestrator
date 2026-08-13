# Frozen normal-user experience contract

This document is the release acceptance contract for WCO's normal user path. Historical phase documents and optional compatibility transports do not override it.

## End-user steps

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

On first use only, WCO guides the user through the **official OpenAI/ChatGPT Web setup required to connect ChatGPT to the private WCO MCP server on that same user's machine**. This is an OpenAI account/workspace authorization/configuration boundary, not a WCO-hosted service.

Current Secure MCP Tunnel prerequisites are provider-owned: a tunnel ID and runtime API key, plus the ChatGPT connector/Workspace Agent configuration needed for automatic Web turns. WCO must not pretend those provider requirements can be replaced by a fictional one-click API. It should guide and validate them once, store resulting credentials only in owner-protected local WCO storage, and never ask for them again during normal tasks.

After that one-time OpenAI setup, daily use is only:

```bash
cd /path/to/project
wco
```

and a goal, for example:

```text
Add rate limiting to login and add regression tests.
```

WCO automatically starts every required ChatGPT Web author/review turn. Per-task browser interactions = 0.

The successful terminal product state is `READY_FOR_YOU` with an exact reviewed Draft PR. The human alone decides merge/release.

## Local-only authority rule

The normal path is `web_native_mcp`.

All WCO-owned engineering state remains on the user's machine:

- repository/worktree state;
- durable task/session state and receipts;
- context cache/read coverage;
- local semantic mailbox;
- local MCP server;
- Harness mutation authority;
- deterministic verifier/sandbox state;
- locally protected OpenAI transport credentials.

The official OpenAI Secure MCP Tunnel client is an **outbound-only transport** from the user's machine to OpenAI. WCO does not require an inbound workstation port or a public WCO endpoint.

There is no normal-path WCO SaaS/control-plane/database/mailbox server.

## Forbidden normal-user infrastructure

The normal path must never require the user to configure:

- a WCO-hosted backend or managed WCO service;
- Cloudflare;
- ngrok;
- a VPS;
- a custom domain or DNS;
- AWS or another third-party cloud relay;
- a user-hosted OAuth server;
- public localhost/workstation ingress;
- WCO relay secrets;
- a Custom GPT/OpenAPI Action;
- manual task/result ZIP handoff;
- run IDs or internal phase commands.

Optional compatibility profiles may expose relay/hosted concepts only after an advanced user deliberately selects that profile. WCO must never auto-fallback to one after local OpenAI capability/setup failure.

## OpenAI setup boundary

`web_native_mcp` is the default because it preserves local authority while using OpenAI's supported private-MCP transport.

WCO owns the local lifecycle after initial provider setup:

```text
wco
  -> local MCP/mailbox
  -> local tunnel-client supervision
  -> outbound OpenAI tunnel
  -> ChatGPT Workspace Agent/App
```

WCO should download/verify or use its pinned supported `tunnel-client`, create the local runtime profile, run readiness checks, start/reuse the local tunnel process, and recover it after restart without exposing those mechanics during daily use.

If the current OpenAI account/workspace lacks the required Tunnel / full MCP / Workspace Agent capabilities, WCO must fail closed with an actionable `OPENAI_CAPABILITY_BLOCKED`-class status. It must not tell the user to deploy Cloudflare/ngrok/VPS or silently change transport.

`managed_actions`, `personal_actions`, `actions_relay`, and `manual_file` are explicit optional compatibility profiles, not the normal installation path.

## Mode invariants

PAIR:

```text
Codex/model reviewer calls = 0
Harness model tokens        = 0
independent Web-B review    = required
original Web-A final review = required
```

AUTOPILOT:

```text
adaptive Sol/Terra calls      = exactly 1 by default
second Sol/Terra after repair = 0
Harness model tokens          = 0
original Web-A final review   = required
```

Both modes preserve exact Git/digest/evidence binding, same-Draft-PR repair/recovery and the human-only shipment boundary.

## Machine-auditable UX budget

A releasable normal-user path has this budget **after the one-time official OpenAI setup**:

```text
WCO-hosted services                 = 0
third-party relay/cloud setup       = 0
public localhost/inbound ports      = 0
per-task browser interactions       = 0
per-task tunnel/key/token inputs    = 0
per-task MCP/App configuration      = 0
Harness model tokens                = 0
```

The first-run setup budget is provider-capability driven and must be represented truthfully. WCO may guide only the current official OpenAI setup surfaces required for the local Secure MCP path; it must not invent additional infrastructure or claim a single-click provisioning API where OpenAI does not provide one.

## Audit rule

A release/audit agent must treat any newly introduced mandatory normal-user infrastructure outside this document as a product defect. After OpenAI setup succeeds once, any newly introduced per-task browser, credential, tunnel, endpoint, relay, server, or deployment step is also a product defect.

Local prerequisites remain Linux/WSL, Node/npm, Git, Bubblewrap, GitHub authentication for Draft-PR delivery, and AUTOPILOT reviewer authentication where selected.