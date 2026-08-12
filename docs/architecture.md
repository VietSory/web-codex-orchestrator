# Architecture

WCO is a durable local control plane between untrusted external semantic proposals and a human-owned Git merge decision. Correctness is based on exact identities, deterministic verification and durable receipts—not on conversational continuity.

## System boundary

```text
ChatGPT Web semantic authority
        ↓
bounded schema + exact identity
        ↓
WCO local durable state
        ↓
Harness mutation + deterministic verification
        ↓
mode-specific code review
  PAIR: independent Web-B
  AUTO: exactly one frozen Sol/Terra pass
        ↓
exact Git/GitHub publication evidence
        ↓
original Web-A final intent verdict
        ↓
human merge/release authority
```

Browser UI, ChatGPT/Codex transcripts, provider run status, terminal output, MCP transport state and caches are transport/diagnostic surfaces. They never become repository or lifecycle mutation authority.

## Default Web-native transport

The preferred/default single-user profile is `web_native_mcp`:

```text
WCO local
  |
  | durable semantic mailbox + exact reads
  v
WCO MCP stdio adapter
  ^
  | pinned/checksummed official openai/tunnel-client
  | outbound HTTPS only
  |
OpenAI Secure MCP Tunnel
  |
private WCO MCP app in ChatGPT
  |
private WCO Workspace Agent
  ^
  | official Workspace Agent trigger API
  |
WCO local
```

The workstation never exposes a public inbound HTTP endpoint. The normal user does not provision Cloudflare, ngrok, a VPS, domain/DNS, AWS, external OAuth infrastructure or a relay secret. WCO owns the local tunnel-client lifecycle and stores native OpenAI credentials only in owner-protected WCO credential storage, outside trusted repository configuration.

The MCP adapter exposes bounded exact repository reads plus three semantic submit capabilities: contract, implementation authority and review verdict. These submit tools are correctly classified as writes at the MCP/ChatGPT permission layer because they append semantic state, but they are **non-destructive with respect to the repository**. They cannot write the worktree, run shell/Git, verify, publish, merge, deploy or release. Harness remains the sole mutation authority.

For zero-click daily operation, a workspace may configure those specific semantic submit tools for no per-run confirmation during the one-time private App/Agent setup when its OpenAI security policy explicitly permits that setting. WCO never lies about tool annotations or bypasses platform approval policy.

Original Web-A author/final-review activity uses one stable Workspace Agent `conversation_key`; independent PAIR Web-B review uses a separate identity. Workspace Agent triggers use deterministic idempotency keys. Suspended, failed, ambiguous or completed-without-required-output provider runs fail closed; they cannot authorize mutation and never cause automatic transport fallback.

### OpenAI capability boundary

Secure MCP Tunnel, the required full MCP tool capabilities and Workspace Agent APIs are not available to every OpenAI plan/workspace. If the required official capabilities are unavailable, WCO reports `OPENAI_CAPABILITY_BLOCKED` or a more specific Web-native error. It does not substitute a third-party relay, browser automation, public ingress or undocumented ChatGPT interfaces.

This is an explicit platform-capability boundary. WCO must not weaken its authority model to make an unsupported account appear compatible.

## Optional compatibility transports

Explicit advanced profiles remain:

```text
personal_actions  → Custom GPT Action + Bearer RelayProtocol endpoint
 actions_relay    → legacy self-hosted Bearer profile
 managed_actions  → organization/hosted OAuth + account/device
 manual_file      → offline/manual artifact compatibility
```

They implement the same `WebBridge` semantic boundary and cannot gain Harness/Git authority. The optional Cloudflare Worker is merely a reference implementation for `personal_actions`; it is not default, not a normal-user dependency and not a Web-native release gate.

## Context architecture

Repository context is progressive and exact:

```text
goal
→ exact repository identity/map/search
→ ranked relevant paths/regions
→ bounded exact reads on demand
→ content-addressed cache references for unchanged bytes
→ diff/result deltas
```

Base commit, tree/blob SHA, Result digest, generation and contract digest identify immutable context. The local cache is disposable performance state. Canonical Git objects and durable read receipts are re-attested wherever context becomes mutation authority. Full exact reads/preimages remain required before replace/delete operations.

PAIR sends no model-review turn. AUTOPILOT retains exactly one adaptive reviewer call by default. Harness and deterministic verification use zero model tokens.

## Authority hierarchy

From stronger to weaker authority:

1. trusted WCO configuration and registered repository policy;
2. canonical accepted task/run identity and sealed semantic contract;
3. exact Git repository/base/tree state;
4. immutable registered Web artifacts and exact operation preimages/postimages;
5. Harness transaction/repair checkpoints and deterministic verification bound to an exact change-set digest;
6. mode-specific code-review evidence bound to that digest;
7. exact Git/GitHub publication, Draft PR and Result Bundle evidence;
8. original Web-A final verdict bound to the freshly attested published head;
9. durable orchestration receipts that advance only after re-attesting stronger evidence above;
10. provider status, logs, UI/session state and caches.

Recovery follows the same hierarchy. A cached/provider `success` flag cannot overrule changed Git, archive, PR, Result Bundle, review or digest identity.

## Mode-specific review authority

### PAIR

PAIR has **no Codex dependency**. After deterministic verification, an independent Web-B identity may approve, escalate or return bounded repair authority. Harness applies/reverifies any repair. Original Web-A remains a separate mandatory final intent reviewer.

PAIR model/Codex reviewer calls = 0. Harness model tokens = 0.

### AUTOPILOT

AUTOPILOT uses exactly one frozen Sol/Terra reviewer on the normal path. That reviewer has read/review authority only. It may return a complete bounded repair set in that same call; Harness validates/applies/reverifies it.

Original Web-A final review remains mandatory. A final Web-A `REVISION_REQUESTED` is Web-proposed + Harness-applied, fast-forwards the same Draft PR, creates a new immutable result generation, and returns to Web-A. It does **not** invoke Sol/Terra a second time.

Legacy model-owned Phase 4/Phase 8 surfaces remain compatibility code for older prepared runs, not normal Harness-first authority.

## Harness owns every mutation

Web/model reviewers can propose only closed bounded operations (`create_file`, `replace_file`, `delete_file`) with exact path/preimage/postimage identity. The same Harness transaction machinery owns worktree writes, rollback, repair checkpoints and exact digest calculation regardless of who proposed the change.

MCP, Workspace Agent, GPT Action, relay and manual-file transports can only deliver semantic envelopes. None is allowed direct shell/filesystem/Git authority.

## Fail-safe defaults and complete mediation

Ambiguity is a stop condition. Security-sensitive state is revalidated where it becomes authority.

Applied in WCO:

- unsupported/malformed semantic authority fails closed instead of guessing;
- provider capability/auth failures never enable another transport automatically;
- Git/GitHub identities are re-attested before irreversible boundaries;
- Web/model, transport, verifier, Git and GitHub capabilities remain separated;
- dangerous actions stay outside the autonomous command set;
- missing isolation never falls back to unrestricted host execution.

## End-to-end correctness

Lower layers validate their own work, while orchestration endpoints still verify the property that matters to the user:

- a push is adopted only after the expected remote SHA is observed;
- a Draft PR becomes authority only after repository/base/head/draft state are re-attested;
- Result Bundles and Web verdicts bind the exact published head;
- repairs bind the exact review/result generation they answer;
- crash recovery adopts exact completed side effects rather than blindly replaying them.

## Write-ahead recovery and idempotency

WCO persists the smallest durable authority required before external/model/provider side effects. Workspace Agent triggers, model review, commit, push, PR creation and result generation are idempotency/recovery boundaries.

If a response/side effect is already durably bound, WCO reuses/adopts it. If a provider call outcome is ambiguous, WCO does not blindly replay it. This reduces duplicate side effects, token usage and semantic drift.

## Bounded resources

Every adversarial or long-lived surface has explicit bounds: archive entries/bytes, JSON receipts, repository reads/regions, subprocess output/time, retries, events, candidate scans, provider/model turns, repair generations and concurrency. Bounds are correctness constraints, not merely performance tuning.

## Parallel reads, serialized authority

Independent exact reads, research, context ranking and safe attestations may run concurrently. Mutation, artifact selection, repair adoption, commit/push, publication promotion and lifecycle state transitions remain serialized. WCO does not add agents merely to increase nominal parallelism when coordination/context cost would exceed benefit.

## Content-addressed evidence

Stable artifacts are named/compared by hashes or immutable Git identities wherever practical. Derived maps, summaries and caches may accelerate retrieval but can never create authorization. Deleting a cache must not change a mutation decision.

## Human boundary

Neither PAIR nor AUTOPILOT automatically merges, marks a PR ready, enables auto-merge, force-pushes, directly pushes protected branches, deletes remote branches, deploys, tags, publishes npm packages or releases. `READY_FOR_YOU` means the exact result is ready for human review; it is not shipment authority.

## Product entry point

The normal product path is:

```text
npm install -g web-codex-orchestrator
cd repository
wco
→ one-time official OpenAI/ChatGPT Web-native authorization if needed
→ goal
→ reviewed Draft PR
→ READY_FOR_YOU
→ human merge/release
```

The interactive TUI and transport adapters sit over durable orchestration services; they are not parallel authority state machines. See [web-bridge.md](web-bridge.md), [ADR 0002](adr/0002-official-openai-web-native-default.md), [job-modes.md](job-modes.md), [operations.md](operations.md) and [protocols.md](protocols.md).