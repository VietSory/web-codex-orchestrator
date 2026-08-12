# Frozen normal-user experience contract

This document is the release acceptance contract for WCO's normal user path. Historical phase documents and optional compatibility transports do not override it.

## End-user steps

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

On first run only, WCO may guide the user through one-time **official OpenAI/ChatGPT** Web-native authorization/configuration. WCO owns all local bridge/tunnel lifecycle work.

After that, daily use is:

```bash
cd /path/to/project
wco
```

and a goal, for example:

```text
Add rate limiting to login and add regression tests.
```

The successful terminal product state is `READY_FOR_YOU` with an exact reviewed Draft PR. The human alone decides merge/release.

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
- manual task/result ZIP handoff;
- run IDs or internal phase commands.

Optional compatibility profiles may expose some of those concepts only after an advanced user deliberately selects that profile. WCO must never auto-fallback to one after Web-native capability/auth failure.

## Official OpenAI capability boundary

`web_native_mcp` requires the official OpenAI capabilities WCO uses: Secure MCP Tunnel, the required MCP tool permissions, and private Workspace Agent trigger access. If the user's plan/workspace does not expose them, WCO must stop with `OPENAI_CAPABILITY_BLOCKED` or a more specific Web-native error.

Capability failure is not permission to scrape ChatGPT, use undocumented endpoints, expose the workstation publicly, or silently ask the user to configure Cloudflare/another relay.

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
adaptive Sol/Terra calls    = exactly 1 by default
second Sol/Terra after repair = 0
Harness model tokens        = 0
original Web-A final review = required
```

Both modes preserve exact Git/digest/evidence binding, same-Draft-PR repair/recovery and the human-only shipment boundary.

## Audit rule

A release/audit agent must treat any newly introduced mandatory normal-user step outside this document as a product defect unless it is an unavoidable prerequisite already stated by WCO (Linux/WSL, Node/npm, Git, Bubblewrap, GitHub authentication for Draft-PR delivery, and AUTOPILOT reviewer authentication where selected).