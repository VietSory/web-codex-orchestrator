# ChatGPT Web bridge

WCO integrates ChatGPT Web through an explicit `WebBridge` profile while keeping repository authority, durable state and exact evidence local.

## Default: `web_native_mcp`

The normal architecture is local-only WCO plus OpenAI's supported outbound Secure MCP Tunnel:

```text
ChatGPT / OpenAI
        |
        | OpenAI tunnel transport
        ^
        | outbound only
user machine
+----------------------------------------+
| tunnel-client                           |
|       |                                 |
| local WCO MCP semantic server           |
|       |                                 |
| local durable mailbox / exact reads     |
|       |                                 |
| WCO Harness -> verify -> Git/Draft PR   |
+----------------------------------------+
```

No WCO-hosted service is required. The default does not require Cloudflare, ngrok, a VPS, a WCO domain/DNS, AWS, a third-party relay, public localhost, a remote WCO mailbox/database or maintainer-operated control plane.

The tunnel is transport only. It cannot edit files, run shell/Git, verify code, publish, merge, deploy or release. ChatGPT/model output remains untrusted semantic input; Harness is the sole repository mutation authority.

## One-time provider setup

`wco web connect` configures the official local transport. WCO opens the relevant official OpenAI/ChatGPT pages, stores sensitive provider credentials only in owner-protected WCO credential storage outside repositories, validates the pinned tunnel client, and then owns the local tunnel lifecycle during normal interactive use.

Current OpenAI provider setup may require a tunnel ID/runtime credential, MCP connector/App and Workspace Agent API channel. WCO must describe these requirements truthfully rather than fabricating a one-click WCO service. If OpenAI later supplies a supported one-click authorization/provisioning API, WCO may simplify this setup without changing the local-authority architecture.

After setup, routine tasks require no browser interaction. WCO reuses the configured transport and local mailbox.

If the required OpenAI capability is unavailable, WCO fails closed with an explicit capability/setup diagnostic. It never silently deploys or suggests Cloudflare/ngrok/VPS as the normal continuation.

## Workspace Agent dispatch semantics

The current Workspace Agent trigger is dispatch-only from WCO's point of view:

```text
POST trigger
→ 202 Accepted
→ wait for exact semantic envelope through local WCO MCP tools/mailbox
```

WCO does not parse a fictional response body into a provider run id and does not poll an undocumented run-status endpoint. It records a deterministic local trigger receipt bound to the trigger identity/idempotency key and advances authority only when exact semantic evidence arrives locally.

This has two benefits:

- correctness: provider state is not invented;
- performance: no repeated provider status GETs are emitted while WCO waits.

## Local MCP semantic surface

The native MCP surface is intentionally narrow. It exposes bounded task/context retrieval plus semantic submission operations. Semantic submit tools are not repository-write tools. They write bounded envelopes to the local WCO control plane; Harness later validates and applies any permitted mutation.

Repository retrieval uses the sealed Git base and bounded exact reads. Tree/search/file/byte-region responses have count, byte and time limits. Sensitive paths such as environment files, credentials, keys/secrets and Git metadata are denied. Immutable content may be reused through content-addressed cache/digest references, but cache state never creates mutation authority.

## Runtime lifecycle

Normal interactive WCO:

1. loads owner-local OpenAI transport credentials;
2. starts or reuses the pinned/verified `tunnel-client` for the session;
3. exposes the local WCO MCP process to that tunnel;
4. queues the exact Web author/review turn once;
5. waits on the local durable mailbox with bounded polling;
6. stops its child tunnel cleanly when the interactive session exits.

No listening Internet-facing WCO port is created.

## Optional compatibility profiles

These are not the normal architecture and are never selected automatically:

- `managed_actions`: optional hosted/team compatibility profile;
- `personal_actions`: optional Custom GPT Action + Bearer/RelayProtocol profile;
- `actions_relay`: legacy self-hosted Bearer compatibility profile;
- `manual_file`: offline/manual compatibility.

The Cloudflare Worker under `web/personal-relay/` is only a reference adapter for an advanced user who explicitly selects that compatibility profile. It is not a release prerequisite or normal-user dependency.

## Doctor behavior

`wco doctor` is mode/transport aware:

- `web_native_mcp`: requires owner-local native credentials and reports that no third-party relay or managed device/account is required;
- optional relay/managed modes probe only their explicitly selected dependencies;
- `manual_file` requires no network bridge;
- PAIR never probes Codex runtime/auth;
- AUTOPILOT adds only the selected Sol/Terra reviewer runtime/auth prerequisites.

Browser DOM automation, ChatGPT cookie/session scraping, automated UI-output extraction, undocumented private ChatGPT endpoints and product/rate-limit bypass are not supported WCO transports.
