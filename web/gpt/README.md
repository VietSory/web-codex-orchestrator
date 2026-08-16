# WCO Web semantic compatibility assets

These files are **not part of the normal single-user setup path**.

The normal WCO path is zero-config local ChatGPT/Codex: install the packaged CLI in Linux/WSL, run `wco` inside the target repository, complete the bundled official Codex ChatGPT authorization when needed, and give WCO a goal. Normal users do **not** create a Custom GPT, MCP app, Workspace Agent, Action schema, relay, tunnel, public endpoint, domain, or API key.

The assets in this directory remain packaged only for explicit advanced/compatibility Web transports and historical interoperability:

- `WCO-SENIOR-ARCHITECT.md` contains semantic instructions for advanced Web profiles that deliberately use those assets. It is not a required normal-user prompt or setup step.
- `openapi.yaml` is retained for optional `managed_actions` / Action-relay compatibility. Its reserved `deployment-required.invalid` origin is intentionally non-routable until a real advanced deployment is configured and must never be presented as a normal endpoint.
- advanced `personal_actions` users may deliberately run `wco web setup --personal`; that profile can require a user-selected RelayProtocol-compatible HTTPS endpoint and its own authorization material.
- `web_native_mcp`, Workspace Agent, Secure MCP Tunnel, managed actions, personal actions, action relays, and manual-file flows are opt-in compatibility profiles only. WCO must never auto-fallback to them when the local ChatGPT/Codex path is unavailable.

Regardless of transport, semantic/provider output is not repository or shipment authority. Web-compatible layers may retrieve bounded exact context and submit closed semantic/implementation/review envelopes only. WCO/Harness retains local mutation, verification, Git, Draft-PR, merge, deployment, and release boundaries.

For normal installation and daily use, follow the repository root `README.md` and `docs/user-experience-contract.md`, not the compatibility assets in this directory.
