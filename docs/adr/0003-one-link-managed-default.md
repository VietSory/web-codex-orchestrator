# ADR 0003 — One-link managed Web authorization is the normal-user default

Status: accepted. This ADR supersedes ADR 0002 for the normal-user transport choice. `web_native_mcp` remains an advanced/operator profile.

## Decision

The normal WCO user experience is frozen to:

```text
npm install -g web-codex-orchestrator
cd /path/to/project
wco

first run only:
  WCO opens exactly one maintainer-operated HTTPS authorization URL
  user authorizes WCO
  WCO receives and stores a scoped refreshable device credential

after that:
  wco
  > goal
```

There is no per-task browser action.

The default trusted config is `managed_actions`. The managed WCO service is operated by the WCO maintainer/service owner and owns all infrastructure and provider credentials required to make ChatGPT Web turns automatic.

## Why not per-user Secure MCP Tunnel as the default?

OpenAI Secure MCP Tunnel is a useful official advanced transport, but its current setup requires a tunnel ID, runtime API credential, ChatGPT MCP/App setup, and compatible workspace permissions. Workspace Agent API triggering also requires separately provisioned agent credentials. Exposing those operator/developer controls to every WCO end user violates the frozen product requirement.

Therefore `web_native_mcp` remains available only when an advanced user/operator deliberately selects `wco web connect --native`.

## Managed ownership split

Normal end user owns only:

- the local WCO installation;
- the local repository;
- one browser authorization decision;
- the final human merge/release decision.

The maintainer-operated WCO Web service owns:

- stable HTTPS service hosting;
- ChatGPT OAuth/account authorization backend;
- WCO ChatGPT App/MCP/connector configuration;
- Senior Architect / Workspace Agent configuration;
- Workspace Agent trigger credentials;
- automatic author, independent-review and final-intent-review triggering;
- refresh/revocation endpoints for scoped WCO device credentials.

Those are release/operator prerequisites, not end-user setup steps.

## One-link security flow

WCO creates an expiring device registration with a random device ID, client nonce and PKCE S256 challenge. The service returns one `verification_uri_complete`. WCO opens that URL once. After authorization, WCO exchanges the one-time device code using the verifier and stores only the scoped access/refresh credential in owner-protected WCO storage outside the repository.

Returning sessions silently refresh the credential. A revoked credential may require the same one-link authorization again; no keys, IDs, endpoints or provider credentials are copied by the user.

## Automatic semantic turns

After connection, normal tasks require no browser interaction:

```text
user prompt
→ WCO creates exact managed authoring job
→ managed control plane automatically triggers Web-A
→ Web-A submits bounded semantic authority to managed relay
→ WCO Harness applies/verifies
→ managed control plane automatically triggers independent Web-B when PAIR requires it
→ managed control plane automatically resumes original Web-A for final intent review
→ READY_FOR_YOU
```

The managed service must preserve the original Web-A conversation/intent identity for final review and use an independent conversation for Web-B. It may not become repository mutation authority.

## Authority boundary

Managed transport can carry only bounded semantic requests/results. It cannot edit the local repository, execute shell/Git, bypass verification, approve publication, merge, mark ready, tag, deploy or release. Harness remains the sole mutation/verification authority; humans alone ship.

## Forbidden normal-user requirements

The normal path must never ask the end user to configure or copy/paste:

- Cloudflare, ngrok, VPS, AWS, custom domain or DNS;
- relay URL, GPT URL or public localhost;
- bearer/relay secret;
- tunnel ID;
- OpenAI runtime API key;
- Workspace Agent trigger ID;
- Workspace Agent access token;
- Custom GPT/OpenAPI schema;
- MCP App or Workspace Agent creation;
- user-hosted OAuth service;
- ZIP bundles, run IDs or internal phase commands.

There must be no silent fallback from a failed managed service to any of those profiles.

## Release gate

A release is not end-user ready until the maintainer-operated service metadata is `available`, all operator-side ChatGPT/Agent automation is configured, and live acceptance proves:

```text
first-run browser authorization URLs = exactly 1
manual credential/ID/endpoint inputs = 0
per-task browser interactions         = 0
PAIR model-review calls               = 0
AUTOPILOT adaptive reviewer calls     = exactly 1 by default
second Sol/Terra call                 = 0
Harness model tokens                  = 0
human-only merge/release              = preserved
```

If the managed service is not deployed, report an operator/release blocker. Never instruct the end user to deploy the service.