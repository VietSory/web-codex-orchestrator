# ADR 0002: official OpenAI Web-native transport as a default

Status: **superseded by [ADR 0003](0003-one-link-managed-default.md)**
Decision date: 2026-08-13
Historical only: this document no longer defines the normal-user transport.

## Historical decision

ADR 0002 introduced `web_native_mcp`, the local WCO MCP adapter, pinned/checksummed `openai/tunnel-client`, outbound-only Secure MCP Tunnel operation, Workspace Agent triggering, exact bounded repository reads and the semantic submit boundary.

Those implementation pieces remain useful and supported for explicit advanced/operator use:

```text
wco web connect --native
```

The authority model remains valid: native MCP can submit bounded semantic contract/implementation/review envelopes but cannot edit the worktree, execute shell/Git, verify, publish, merge, deploy or release. Harness remains the sole mutation authority.

## Why the default changed

Maintainer re-audit found that the provider's current native setup requires developer/operator configuration such as tunnel identity/runtime credential, ChatGPT App/MCP setup and Workspace Agent trigger credentials. Requiring every end user to copy or configure those values violates WCO's frozen product requirement:

```text
npm install -g web-codex-orchestrator
cd project
wco
→ exactly one browser authorization
→ thereafter only prompts
```

Therefore ADR 0003 makes the maintainer-operated `managed_actions` control plane the normal default. Operator-side provider/App/Agent credentials are provisioned once by the service owner, while each end user receives only one device/PKCE authorization URL and a scoped refreshable WCO credential.

## What remains from this ADR

The following native-mode properties remain required when an advanced user deliberately selects it:

- outbound-only Secure MCP Tunnel transport;
- pinned/checksummed tunnel-client bootstrap;
- owner-protected native credential storage outside repositories;
- closed MCP schemas;
- exact read receipts and bounded semantic submissions;
- stable author identity and independent Web-B identity;
- deterministic trigger idempotency;
- suspended/failed/completed-without-output fail-closed behavior;
- no browser scraping or undocumented ChatGPT APIs;
- no direct repository mutation authority;
- PAIR model-review calls = 0;
- AUTOPILOT adaptive reviewer calls = exactly 1 by default;
- Harness model tokens = 0;
- human-only merge/release.

None of these advanced-native setup steps may leak back into the normal-user path.