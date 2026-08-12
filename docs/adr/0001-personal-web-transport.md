# ADR 0001: profile-based Web transport

Status: accepted for v0.3 release correction
Research date: 2026-08-13

## Decision

WCO keeps `WebBridge` as the transport abstraction and makes
`personal_actions` the recommended single-user profile. It uses a Custom GPT
Action with API-key authentication and a bounded durable relay. Local WCO polls
outbound and the Harness remains the only mutation authority.

`managed_actions` remains the OAuth/account/device profile for future hosted or
multi-user use. `manual_file` remains the offline profile. The historical
`actions_relay` spelling remains an accepted compatibility alias for the same
personal bearer transport; it is not silently reinterpreted as managed OAuth.

The relay protocol is platform-neutral. The shipped Node relay and optional
Cloudflare Workers reference deployment implement the same HTTP envelope
contract. Cloudflare is a deployment adapter, not an authority layer or WCO
product dependency.

Secure MCP Tunnel is an optional future `WebBridge` adapter boundary. It is not
the default and is not selected unless the installed OpenAI product, Platform
organization, ChatGPT workspace and required MCP capabilities are all proven.

Browser automation, ChatGPT DOM extraction, cookie/session scraping and private
ChatGPT endpoints are not supported transports.

## Primary-source research

| Source | What it does | What WCO should learn | What WCO must not copy | Why |
| --- | --- | --- | --- | --- |
| [OpenAI GPT Action authentication](https://developers.openai.com/api/docs/actions/authentication) | Documents None, API Key and OAuth choices in the GPT editor. | API-key authentication is the smallest supported fit for one owner and one relay mailbox; OAuth remains appropriate for per-user managed service identity. | Do not require OAuth when there is no multi-user sign-in problem. | Authentication complexity must match the selected profile. |
| [OpenAI GPT Actions getting started](https://developers.openai.com/api/docs/actions/getting-started) | Defines the OpenAPI-driven Action setup flow. | Materialize an exact OpenAPI document and leave the one-time GPT-editor action to the human. | Do not automate or scrape the GPT editor. | The editor is a human-owned product surface, not orchestration authority. |
| [OpenAI GPT Actions production notes](https://developers.openai.com/api/docs/actions/production) | Requires public TLS, documents time/payload limits and consequential-operation behavior. | Use a stable TLS relay, keep every request bounded below the documented ceiling, use idempotency, and keep the relay transport-only. | Do not expose the workstation directly or place long-running verification behind an Action request. | The local worker must poll outbound and perform authority-changing work locally. |
| [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) | Provides a public `tunnel-client` that long-polls outbound and forwards MCP JSON-RPC to a private server. | Keep an explicit capability-driven MCP adapter boundary; outbound-only long-polling is a sound reachability pattern. | Do not invent tunnel APIs or assume availability: tunnel roles, a runtime API key, ChatGPT developer mode and organization/workspace association are separate prerequisites. | Official support exists, but account/workspace capabilities and the MCP semantic contract must be proven before selection. |
| [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins) and [connect/test guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Defines MCP tools, structured results, developer mode and public/tunnel connection choices. | Expose only bounded semantic tools if an MCP adapter is later implemented, with schemas and observable capability checks. | Do not let MCP tools execute Git, shell, verification or mutation directly. | Transport selection cannot change WCO authority. |
| [OpenAI Codex Remote](https://learn.chatgpt.com/docs/remote) | Runs tasks on a connected trusted computer while remote surfaces guide/review them; the computer must remain online. | Keep the trusted local machine as execution source of truth and make remote state a control/inspection surface. | Do not treat remote conversation state as durable WCO authority. | WCO receipts, exact Git identities and local sandbox attestations remain canonical. |
| [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) | Prohibits automatic/programmatic extraction of data or output and circumvention of restrictions. | Use documented Actions/MCP/API surfaces and remain policy-aware. | Do not ship browser DOM/output extraction, session scraping, private endpoints or rate-limit bypass. | A technically feasible transport is not acceptable if it is unsupported or policy-incompatible. |
| [`miuuyy/codex-chatgpt-web` at `bda266b45c0e9d73c7a6e932a7c556954f9cea9c`](https://github.com/miuuyy/codex-chatgpt-web/tree/bda266b45c0e9d73c7a6e932a7c556954f9cea9c) | Translates Responses/SSE to controlled browser turns, serializes authority-sensitive browser state, compacts context and optionally bridges tools through the official tunnel. | Preserve local task ownership; keep a clean transport boundary; detect capabilities explicitly; serialize mutations; fail closed on drift; make setup/doctor/uninstall/recovery deliberate. | Do not copy controlled-browser DOM interaction, output extraction, cookie/session transfer, selector-based authority or full accumulated-context retransmission. | It is useful prior art but its unofficial browser transport is outside WCO's supported policy boundary and has a different context/authority model. |
| [Cloudflare `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [secrets](https://developers.cloudflare.com/workers/configuration/secrets/) | Provides a no-custom-domain TLS endpoint, a Free plan with SQLite-backed Durable Objects, and encrypted Worker secrets. | Offer one optional personal/hobby reference adapter with a stable TLS endpoint and provider-managed secret. | Do not make Cloudflare, a paid plan, DNS or a custom domain mandatory. | It is a convenient reference deployment, not the relay protocol or lifecycle authority. |

## Context and performance consequence

WCO local state remains the repository-context source of truth. Initial Web
authoring sends a compact exact-base map and sealed constraints, then serves
bounded exact reads on demand. Later phases send exact changed-path/diff/result
deltas and digest references, not the whole repository or irrelevant transcript.

The local cache is keyed by immutable Git/tree/blob/range/result identities. It
is disposable performance state only. Read receipts, preimages, Result digests
and review generations remain canonical authority and are re-attested without
trusting a cache hit.
