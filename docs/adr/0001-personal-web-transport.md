# ADR 0001: profile-based Action/relay transport

Status: **superseded by ADR 0002**
Research date: 2026-08-13
Superseded: 2026-08-13

## Historical decision

This ADR originally made `personal_actions` (Custom GPT Action + Bearer + bounded durable relay) the recommended single-user profile, while retaining `managed_actions`, `manual_file`, and the legacy `actions_relay` spelling.

That transport remains valid as an **advanced compatibility profile**, but it is no longer WCO's default. The final product requirement is that a normal user must not configure Cloudflare, ngrok, a VPS, a domain, DNS, AWS, a public workstation endpoint, external OAuth infrastructure, or a relay secret.

ADR 0002 replaces the default with official OpenAI Web-native transport using Secure MCP Tunnel plus a private WCO Workspace Agent. Unsupported OpenAI account/workspace capability fails closed instead of silently enabling the historical relay path.

## Findings retained from this research

The parts of this ADR that remain valid are:

- `WebBridge` is a transport abstraction; transport never becomes workflow authority.
- Harness is the only mutation authority.
- RelayProtocol is platform-neutral and may remain as an optional adapter.
- `managed_actions` remains useful for organization/hosted use.
- `manual_file` remains an offline compatibility path.
- Browser DOM automation, ChatGPT output extraction, cookie/session scraping, undocumented endpoints and access/rate-limit bypass are not supported.
- Repository context remains exact-base, bounded, content-addressed and receipt-backed.
- Cloudflare Workers may remain a reference implementation for users who explicitly select the advanced personal relay profile, but Cloudflare is not a WCO dependency or release requirement.

## Why superseded

The earlier decision optimized the relay itself but still imposed third-party infrastructure setup on a one-user local workflow. Current official OpenAI Secure MCP Tunnel and Workspace Agent surfaces allow WCO to keep the trusted machine outbound-only while making OpenAI/ChatGPT the only external setup surface. That better matches WCO's frozen normal-user UX contract.

See [ADR 0002](0002-official-openai-web-native-default.md) for the authoritative decision.