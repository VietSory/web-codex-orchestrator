# ChatGPT Web bridge

WCO integrates ChatGPT Web through an explicit `WebBridge` profile while keeping all repository mutation authority local.

## Default: `web_native_mcp`

The normal single-user path is official OpenAI Web-native transport:

```text
ChatGPT private WCO Workspace Agent
        |
        | WCO MCP app
        v
OpenAI Secure MCP Tunnel
        ^
        | outbound HTTPS only
        |
WCO local MCP semantic adapter
        |
WCO durable state / exact repository reads
        |
Harness
```

The developer workstation is never exposed as a public HTTP server. The default path does not require Cloudflare, ngrok, a VPS, a custom domain, DNS, AWS, a user-hosted OAuth service, or a relay secret.

First-run setup is one-time and uses official OpenAI/ChatGPT web surfaces only. `wco web connect` opens the relevant OpenAI Platform and ChatGPT configuration pages, guides the user through Secure MCP Tunnel + private WCO Workspace Agent authorization, stores resulting credentials only in owner-protected WCO credential storage, verifies that the official tunnel can reach the local WCO MCP server, and then returns to normal CLI operation. WCO pins and checksum-verifies the official `openai/tunnel-client` binary it runs locally.

The local MCP adapter is intentionally narrow. It exposes exact task/repository retrieval plus non-destructive semantic submissions for contract, implementation authority and review verdicts. Those semantic submit tools append bounded envelopes to WCO durable state; they do not edit files, execute shell or Git, verify code, publish, merge, deploy or release. Harness remains the only repository mutation authority.

For zero-click daily use, the one-time private Workspace Agent/App setup should configure WCO's three semantic submit tools to avoid per-run confirmation when the workspace's security policy permits it. If OpenAI suspends a Workspace Agent run for interaction or the run completes without the required semantic output, WCO fails closed with an explicit diagnostic instead of hanging or silently enabling another transport.

A Workspace Agent trigger is content/idempotency bound. WCO uses one stable author conversation for original Web-A intent continuity, while independent PAIR code review uses a separate conversation identity. Provider failures and ambiguous states never authorize a repository mutation.

## OpenAI capability boundary

The official features WCO needs are not available on every ChatGPT/OpenAI plan or workspace. WCO must detect/validate the required Secure MCP Tunnel, full MCP tool and Workspace Agent capabilities. When they are unavailable, the normal path stops with `OPENAI_CAPABILITY_BLOCKED` (or a more specific Web-native diagnostic). WCO does **not** silently substitute Cloudflare, browser automation, a public endpoint, or another third-party relay.

An unsupported OpenAI account is a platform-capability boundary, not permission to weaken WCO's security/authority model.

## Exact repository context

Local WCO reads only Git objects at the sealed base commit for Web authoring. Tree/search/file/byte-region responses have count, byte and time limits; `.env`, keys, credentials, secrets and Git metadata are denied. Immutable blob/range content is cached by digest and a caller may send a known digest to avoid retransmission. The cache is disposable performance state. Every read creates a local receipt, and replacement/deletion authority still requires a full exact read receipt and locally derived preimage.

## Optional compatibility profiles

These remain supported but are not the normal installation path:

- `personal_actions`: advanced Custom GPT Action + Bearer/RelayProtocol deployment. The optional Cloudflare Workers adapter under `web/personal-relay/` is only a reference implementation.
- `actions_relay`: legacy spelling for the advanced self-hosted Bearer profile.
- `managed_actions`: organization/SaaS OAuth, account and device onboarding.
- `manual_file`: offline/manual compatibility path.

`web/managed-service.json` applies only to `managed_actions`; missing managed service metadata never disables Web-native or manual operation. WCO never auto-switches profiles after a capability/auth failure.

## Doctor behavior

`wco doctor` is mode- and transport-aware:

- `web_native_mcp`: checks owner-local OpenAI Web-native credentials and does not probe a third-party relay or managed device/account.
- `personal_actions` / `actions_relay`: probes only that optional bearer relay.
- `managed_actions`: probes managed service/OAuth/device state.
- `manual_file`: performs no network bridge requirement.
- PAIR never probes Codex runtime/auth.
- AUTOPILOT additionally checks only the selected Sol/Terra review runtime/auth prerequisites.

Browser DOM automation, ChatGPT cookie/session scraping, automatic UI-output extraction, private ChatGPT endpoints and undocumented product APIs are not supported transports.