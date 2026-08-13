# Frozen normal-user experience contract

This document is the release acceptance contract for WCO's normal user path. Historical phase documents and optional compatibility transports do not override it.

## End-user steps

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

On the first run only, WCO opens **exactly one HTTPS authorization link** for the maintainer-operated WCO Web service. The user authorizes once and returns to WCO. There are no terminal credential questions and no second Web configuration page.

After that, daily use is only:

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

## Zero-copy/paste rule

The normal path must never ask the user for a service endpoint or provider credential. In particular there is no manual tunnel ID, no OpenAI/API key, no Workspace Agent trigger ID, no Workspace Agent access token, no relay/GPT URL and no bearer secret.

The user must never create a Custom GPT/OpenAPI Action, MCP App, Workspace Agent, OAuth server or cloud relay as part of normal WCO setup. Those are maintainer/operator responsibilities when required by the managed service.

## Forbidden normal-user setup requirements

The normal path must never require the user to configure:

- Cloudflare;
- ngrok;
- a VPS;
- a custom domain or DNS;
- AWS or another third-party cloud relay;
- a user-hosted OAuth server;
- public localhost/workstation ingress;
- WCO relay secrets;
- tunnel IDs or runtime API keys;
- Workspace Agent IDs/tokens;
- GPT/App/MCP schemas or connector creation;
- manual task/result ZIP handoff;
- run IDs or internal phase commands.

Optional compatibility profiles may expose some of those concepts only after an advanced user deliberately selects that profile. WCO must never auto-fallback to one after managed authorization/service failure.

## Managed service/operator boundary

`managed_actions` is the normal default. The WCO maintainer/service owner, not the end user, provisions the stable service, ChatGPT OAuth/App/MCP/Workspace Agent configuration and automatic Agent trigger credentials.

The service returns one expiring device/PKCE verification URL. WCO opens it once, polls the device exchange and stores a scoped refreshable credential in owner-protected WCO storage outside repositories. Returning sessions refresh silently.

If that maintainer-operated service is missing or misconfigured, WCO must report an operator/release defect such as `WEB_MANAGED_OPERATOR_NOT_READY`. It must never tell the normal user to deploy infrastructure, copy provider credentials or switch to Cloudflare/native/manual fallback.

`web_native_mcp` remains an explicit advanced/operator profile (`wco web connect --native`) because its current provider setup exposes developer/operator credentials and configuration that violate this normal-user contract.

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

A releasable normal-user path has this budget:

```text
first-run browser authorization URLs = exactly 1
manual endpoint inputs                = 0
manual tunnel IDs                     = 0
manual API keys                       = 0
manual Workspace Agent IDs/tokens     = 0
manual GPT/App/MCP creation           = 0
per-task browser interactions         = 0
```

Revocation/disconnect may require the same one-link authorization again. It may not introduce any additional manual provisioning.

## Audit rule

A release/audit agent must treat any newly introduced mandatory normal-user step outside this document as a product defect unless it is an unavoidable local prerequisite already stated by WCO (Linux/WSL, Node/npm, Git, Bubblewrap, GitHub authentication for Draft-PR delivery, and AUTOPILOT reviewer authentication where selected).