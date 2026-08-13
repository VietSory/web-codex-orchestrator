# Managed WCO Web service — operator contract

This document is for the WCO service maintainer/operator. It is **not** an end-user setup guide.

Normal end users must only:

```text
wco
→ open one WCO authorization URL
→ authorize once
→ thereafter type goals
```

They must never receive provider infrastructure credentials or deployment instructions.

## Runtime composition

WCO ships platform-neutral service primitives:

- `ManagedServiceRuntime`: `/v1/managed/*` protocol, one-link device/PKCE onboarding, refresh/revoke, automatic Agent triggering, exact Web-A/Web-B identity resolution;
- `createManagedControlPlaneServer`: HTTP listener for the managed prefix;
- `ManagedRelayAuthenticator`: validates scoped WCO device access tokens for the bounded relay server;
- `createRelayServer`: existing bounded semantic mailbox/repository-read transport;
- `ManagedPairingAuthority`: persistence boundary for registrations/access/refresh grants;
- `ManagedAccountAuthorizationAdapter`: account/OAuth boundary behind the one user-visible verification URL;
- `ManagedAgentGateway`: provider-side Workspace Agent trigger/status boundary.

A production deployment routes both the managed prefix and bounded relay routes behind the same stable HTTPS origin advertised by `web/managed-service.json`.

## Mandatory production adapters

### Pairing authority

`ManagedPairingRegistry` is the security-core/reference implementation and intentionally in-memory. A production service must provide a transactionally durable `ManagedPairingAuthority` with equivalent semantics:

- expiring device registrations;
- PKCE S256/device/nonce binding;
- single-use authorization/exchange;
- hashed/raw-secret-minimized storage;
- rotating refresh tokens;
- revocation;
- account/device isolation;
- scoped access-token authentication.

No provider or WCO secret may be logged.

### Account authorization

`ManagedAccountAuthorizationAdapter` owns real account authentication/OAuth state and callback security. The browser-visible WCO verification URL may redirect internally through provider authorization, but the end user must click/configure only the single WCO URL opened by the CLI.

The adapter returns an authenticated WCO account ID only after provider/session authorization succeeds. It must not accept an account ID supplied by the browser query/body.

### Agent gateway

`ManagedAgentGateway` owns provider-side Workspace Agent/App credentials. Its `trigger` implementation must be durable/idempotent by account + idempotency key and honor WCO's deterministic `conversation_key`.

Conversation identity is security/correctness state:

```text
author Web-A
  wco-author-{account}-{author_job_id}

independent Web-B
  wco-review-{account}-{review_id}

final intent review
  final review run_id
  → exact authoring job whose sealed implementation carries that run_id
  → reuse wco-author-{account}-{author_job_id}
```

Never use a global/latest conversation. Concurrent tasks and users must remain isolated.

## Readiness

`GET /v1/managed/service/status` must truthfully expose whether:

- account/OAuth integration is configured;
- Senior Architect/App/Agent integration is configured;
- automatic Agent triggering is configured.

The CLI refuses normal one-link connection if the operator service is incomplete. This is a release/operator blocker, not permission to ask users to deploy Cloudflare, enter tunnel IDs/API keys, configure MCP/Agents, or use browser automation.

## Authority boundary

The managed service has semantic transport authority only. It must never receive local filesystem, shell, Git, verifier, merge, deployment, npm publish or release authority.

Local Harness remains the only mutation/verification authority. Humans alone merge/release.

## Release acceptance

Before setting `web/managed-service.json` to `deployment_status: available`, the maintainer must deploy the real service, install operator credentials privately, and prove with disposable repositories:

```text
first-run user-visible authorization URLs = exactly 1
manual end-user endpoint/credential inputs = 0
per-task browser interactions              = 0
Web-A automatic author turn                = PASS
PAIR independent Web-B                     = PASS
original Web-A final identity              = exact
AUTOPILOT adaptive reviewer calls           = exactly 1 by default
second Sol/Terra                            = 0
Harness model tokens                        = 0
same Draft PR / exact digest binding        = PASS
human-only merge/release                    = preserved
```

Only after that live evidence exists should release metadata advertise the managed service as available.