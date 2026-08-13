# ChatGPT Web bridge

WCO integrates ChatGPT Web through an explicit `WebBridge` profile while keeping repository state, semantic mailbox, evidence and all mutation authority on the user's machine.

## Default: `web_native_mcp`

The normal user path is the official OpenAI Secure MCP Tunnel connected to WCO's local MCP server:

```text
USER MACHINE
  project / worktree
  WCO CLI/TUI
  local state + receipts + context cache
  local semantic mailbox
  local MCP server
  local tunnel-client
  Harness + verifier
          |
          | outbound-only HTTPS
          v
       OpenAI
          |
          v
 ChatGPT App / Workspace Agent
```

There is no WCO-hosted control plane, database, mailbox, relay, SaaS backend or public workstation endpoint in the normal path.

The first OpenAI setup is provider-capability driven. Current Secure MCP Tunnel requires a provisioned tunnel ID and runtime API key, and automatic Web turns require the ChatGPT connector/Workspace Agent configuration supported by the user's account/workspace. WCO guides that setup, validates it, stores resulting credentials only in owner-protected local WCO storage, and starts/reuses the local tunnel runtime afterwards.

`wco web connect` is the normal connection command. `wco web connect --native` remains a compatibility alias for the same local-native setup.

After successful first setup there is no per-task browser action. Creating an authoring job automatically triggers Web-A; pending PAIR review triggers an independent Web-B; final review resumes the original Web-A identity. If the current OpenAI account lacks the necessary capability, WCO fails closed with an `OPENAI_CAPABILITY_BLOCKED`-class status rather than silently enabling a third-party relay.

## Local semantic authority contract

The local MCP surface is intentionally narrow:

- discover the exact pending author/review job;
- request bounded exact repository summary/tree/search/file or byte-region context;
- submit a sealed semantic contract;
- submit bounded implementation authority;
- submit a bounded review verdict/repair authority.

MCP submit tools do **not** write repository files, run shell/Git, publish, merge, deploy or release. Harness remains the only repository mutation authority.

The local mailbox is durable and owner-local. OpenAI receives only the bounded semantic/context traffic necessary for the selected Web turn; WCO's canonical state and recovery receipts do not move to a WCO-operated server.

## Automatic Web turns

When configured, WCO uses the official Workspace Agent trigger/run surface to start semantic turns without browser interaction for each task. Trigger identity is idempotency-bound and separated by purpose:

- `author`;
- `independent_code_review`;
- `final_intent_review`.

Independent Web-B uses a separate conversation identity. Final intent review binds back to the original Web-A task identity. A suspended/failed/completed-without-required-output run fails closed; WCO never treats provider status as mutation authority.

## Exact repository context and performance

Local WCO reads only Git objects at the sealed base commit for Web authoring. Tree/search/file/byte-region responses have count, byte and time limits; `.env`, keys, credentials, secrets and Git metadata are denied.

Immutable content is content-addressed. Callers may send known digests to avoid retransmitting unchanged bytes. The cache is disposable performance state and can never authorize mutation. Every exact read creates local provenance/coverage evidence, and replacement/deletion authority still requires a full exact read receipt and locally derived preimage.

Context delivery remains progressive:

```text
goal/finding
  -> summary/tree/search
  -> focused exact file/region reads
  -> digest reuse for unchanged content
  -> diff/result deltas
```

Full-repository transmission is not the normal path.

## Optional compatibility profiles

These remain supported only after explicit selection:

- `managed_actions`: optional hosted/team integration;
- `personal_actions`: optional Custom GPT Action + Bearer/RelayProtocol deployment;
- `actions_relay`: legacy optional self-hosted Bearer profile;
- `manual_file`: offline/manual compatibility path.

The Cloudflare Worker is only a reference adapter for an optional relay profile. It is never required, recommended, or auto-selected for a normal local-native installation.

WCO never silently switches from `web_native_mcp` to a hosted/relay/manual profile after an OpenAI capability or authentication failure.

## Doctor behavior

`wco doctor` is mode- and transport-aware:

- `web_native_mcp`: validates owner-local OpenAI/tunnel credentials and the local-native Web prerequisites; no third-party relay or managed device/account is required;
- `managed_actions`: probes only when explicitly selected;
- `personal_actions` / `actions_relay`: probes only the explicitly selected optional bearer relay;
- `manual_file`: performs no network bridge requirement;
- PAIR never probes Codex runtime/auth;
- AUTOPILOT additionally checks only the selected Sol/Terra review runtime/auth prerequisites.

Browser DOM automation, ChatGPT cookie/session scraping, automatic UI-output extraction, private ChatGPT endpoints and undocumented product APIs are not supported transports.