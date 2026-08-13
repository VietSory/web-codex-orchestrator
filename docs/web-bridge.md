# ChatGPT Web bridge

WCO integrates ChatGPT Web through an explicit `WebBridge` profile while keeping all repository mutation authority local.

## Default: `managed_actions`

The normal user path is a maintainer-operated WCO Web service with exactly one browser authorization:

```text
first run
  wco
   |
   | device id + nonce + PKCE S256 challenge
   v
managed WCO service
   |
   | one verification_uri_complete
   v
browser: Authorize once
   |
   v
WCO stores scoped refreshable device credential

then every task
  user prompt
   |
   v
WCO managed relay
   |
   v
maintainer-configured ChatGPT Web / Workspace Agent
   |
   v
bounded semantic output
   |
   v
WCO Harness
```

The normal path does not require Cloudflare, ngrok, a VPS, a custom domain, DNS, AWS, public localhost, a user-hosted OAuth service, or any user-entered relay secret.

It also does not ask the end user for a tunnel ID, API key, Workspace Agent trigger ID/token, relay/GPT URL, schema, MCP App, Custom GPT or Agent creation. The maintainer/service owner provisions those provider/infrastructure concerns once globally.

`wco web connect` is the normal connection command. It opens exactly one clean HTTPS verification URL returned by the managed service, polls the PKCE/device exchange and stores only the scoped access/refresh credential in owner-protected WCO credential storage. Returning sessions refresh silently.

There is no per-task browser action. Creating an authoring job automatically starts Web-A. Supplying exact review evidence automatically starts an independent Web-B or resumes original Web-A for final intent review. If automatic triggering is unavailable, suspended or incomplete, WCO fails closed as an operator/service defect instead of asking the end user to open ChatGPT manually.

## Managed automatic-agent contract

The local managed client uses two additional bounded control-plane operations:

```text
POST /v1/managed/agent/trigger
GET  /v1/managed/agent/runs/{run_id}
```

The trigger is authenticated by the user's scoped WCO device credential and idempotency-bound. Its purpose is one of:

- `author`;
- `independent_code_review`;
- `final_intent_review`.

The managed service owns the provider-side Workspace Agent credential. It must map final-intent review back to the original Web-A conversation/intent and create an independent conversation for Web-B. Provider credentials are never sent to local repository context or stored in a project.

Managed transport never receives filesystem, shell, Git, verifier, publication, merge, deploy or release authority. It only moves bounded semantic envelopes. Harness remains the only repository mutation authority.

## Operator readiness boundary

Before a release can advertise the one-link normal path, the maintainer-operated service must report all of these as configured:

- ChatGPT/account authorization backend;
- Senior Architect/App/Agent integration;
- automatic semantic Agent trigger.

If any are absent, WCO reports `WEB_MANAGED_OPERATOR_NOT_READY`. That is a maintainer/release blocker. The end user must not be instructed to deploy infrastructure or copy provider credentials.

## Advanced `web_native_mcp`

Official Secure MCP Tunnel remains supported for advanced/operator use via:

```text
wco web connect --native
```

It is not the normal default because current provider setup exposes tunnel IDs, runtime API credentials, MCP/App configuration and Workspace Agent credentials that violate the one-link end-user contract. WCO never auto-switches a normal user into this profile.

The advanced native path remains outbound-only and keeps the MCP semantic surface narrow; it still cannot mutate repositories directly.

## Exact repository context

Local WCO reads only Git objects at the sealed base commit for Web authoring. Tree/search/file/byte-region responses have count, byte and time limits; `.env`, keys, credentials, secrets and Git metadata are denied. Immutable blob/range content is cached by digest and a caller may send a known digest to avoid retransmission. The cache is disposable performance state. Every read creates a local receipt, and replacement/deletion authority still requires a full exact read receipt and locally derived preimage.

## Optional compatibility profiles

These remain supported only after explicit advanced selection:

- `web_native_mcp`: official Secure MCP Tunnel / local MCP for advanced users/operators;
- `personal_actions`: Custom GPT Action + Bearer/RelayProtocol deployment; the Cloudflare Worker is only a reference adapter;
- `actions_relay`: legacy advanced self-hosted Bearer profile;
- `manual_file`: offline/manual compatibility path.

`managed_actions` is the normal default. `web/managed-service.json` is release/operator metadata compiled into the package; end users do not edit it. WCO never auto-switches profiles after a managed service/auth failure.

## Doctor behavior

`wco doctor` is mode- and transport-aware:

- `managed_actions`: checks maintainer service readiness plus the scoped local device credential; it must not ask the user for provider credentials;
- `web_native_mcp`: checks advanced owner-local native credentials;
- `personal_actions` / `actions_relay`: probes only the explicitly selected optional bearer relay;
- `manual_file`: performs no network bridge requirement;
- PAIR never probes Codex runtime/auth;
- AUTOPILOT additionally checks only the selected Sol/Terra review runtime/auth prerequisites.

Browser DOM automation, ChatGPT cookie/session scraping, automatic UI-output extraction, private ChatGPT endpoints and undocumented product APIs are not supported transports.