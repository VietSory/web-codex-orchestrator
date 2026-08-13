# Frozen normal-user experience contract

This document is the release acceptance contract for WCO's normal user path. Historical phase documents and optional compatibility transports do not override it.

## Product boundary

WCO is a **local-first, local-authority control plane**. The normal installation does not depend on a WCO-hosted service.

The following stay on the user's machine:

- repository/worktree state;
- WCO Harness and all filesystem/Git mutation authority;
- deterministic verification;
- durable run/session/repair/publication receipts;
- repository context cache and read receipts;
- the WCO MCP semantic mailbox/server;
- OpenAI transport credentials stored by WCO.

The only normal Web network path is outbound from the user's machine through OpenAI's supported transport. WCO does not require inbound workstation access.

## End-user steps

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

On first use, WCO performs local repository setup and guides the user through the **one-time official OpenAI/ChatGPT configuration** needed for the local Web transport. WCO may open the official OpenAI/ChatGPT pages required by that provider flow.

WCO must not pretend that current provider resources can be provisioned by a nonexistent WCO cloud service. If OpenAI requires a tunnel ID, runtime credential, MCP connector/App or Workspace Agent/API-channel credential for the selected account/workspace, those are provider-side one-time setup requirements and must be described truthfully.

After the official OpenAI setup has completed, daily use is only:

```bash
cd /path/to/project
wco
```

and a goal, for example:

```text
Add rate limiting to login and add regression tests.
```

WCO starts/reuses the local tunnel runtime automatically for the interactive session and drives required author/review turns without per-task browser work. The successful terminal product state is `READY_FOR_YOU` with an exact reviewed Draft PR. The human alone decides merge/release.

## Forbidden normal-user infrastructure

The normal path must never require the user to configure or deploy:

- a WCO-hosted or maintainer-hosted control plane;
- Cloudflare;
- ngrok;
- a VPS;
- a custom WCO domain or DNS;
- AWS or another third-party cloud relay;
- a user-hosted OAuth server for WCO;
- public localhost/workstation ingress;
- a WCO relay server on the Internet;
- a remote WCO database/mailbox;
- manual task/result ZIP handoff;
- run IDs or internal phase commands.

Optional compatibility profiles may expose relay/managed concepts only after an advanced user explicitly selects them. WCO must never auto-fallback to one after native/OpenAI failure.

## Official local Web transport

The default profile is `web_native_mcp`:

```text
ChatGPT / OpenAI
        |
        | OpenAI-managed tunnel path
        ^
        | outbound only
user machine
+--------------------------------------+
| tunnel-client                         |
|      |                                |
| local WCO MCP semantic server         |
|      |                                |
| local mailbox/context/read receipts   |
|      |                                |
| WCO Harness -> verify -> Git/Draft PR |
+--------------------------------------+
```

The tunnel is transport only. It does not move WCO mutation authority into the cloud. ChatGPT/model output remains untrusted semantic input; Harness alone validates and applies bounded mutations.

Current OpenAI provider setup may expose developer/workspace resources such as a tunnel identity, runtime credential, MCP App/connector and Workspace Agent API channel. WCO stores secrets outside repositories with owner-only permissions and manages the local runtime after setup. WCO must not fabricate a one-click flow where OpenAI has not documented one.

If the required OpenAI account/workspace capability is unavailable, WCO reports an explicit capability/setup blocker. It must not tell the user to deploy Cloudflare/ngrok/VPS or silently switch transports.

## Daily interaction budget

After one-time provider setup:

```text
manual service deployment           = 0
manual WCO server configuration     = 0
public workstation ingress          = 0
per-task browser interactions       = 0
per-task tunnel configuration       = 0
per-task provider credential input  = 0
```

Revocation/provider configuration changes may require repeating the provider-side setup. Routine WCO restarts must not.

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

## Security / locality acceptance

A releasable normal path must prove:

```text
default web_bridge mode               = web_native_mcp
WCO-hosted service required           = no
third-party relay required            = no
public localhost required             = no
repository mutation outside Harness   = no
provider run-status polling invention = no
provider trigger replay after receipt = no
per-task browser interaction          = no after setup
```

The native Workspace Agent trigger is treated according to the current provider contract: `202 Accepted` is a dispatch receipt, not a provider run/result object. WCO does not invent a provider run ID or status API. Completion authority is the exact semantic envelope received through the local WCO MCP mailbox.

## Audit rule

A release/audit agent must treat any newly introduced mandatory WCO-hosted service, Cloudflare/ngrok/VPS/domain, public localhost, silent transport fallback, provider API invention, or extra per-task browser step as a product defect.

Local prerequisites such as Linux/WSL, Node/npm, Git, Bubblewrap, GitHub authentication for Draft-PR delivery, official OpenAI account/workspace capability/configuration, and AUTOPILOT reviewer authentication are not remote WCO infrastructure.
