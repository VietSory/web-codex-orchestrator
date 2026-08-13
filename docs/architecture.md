# Architecture

WCO is a durable local control plane between untrusted external semantic proposals and a human-owned Git merge decision. Correctness is based on exact identities, deterministic verification and durable receipts—not on conversational continuity or provider UI state.

## System boundary

```text
user goal
   ↓
ChatGPT Web semantic authority
   ↓ bounded schema + exact identity
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

Browser UI, provider transcripts/status, terminal output, transport state and caches are diagnostic/transport surfaces. They never become repository or lifecycle mutation authority.

## Normal-user transport: one-link `managed_actions`

The default profile is `managed_actions` because the frozen end-user contract is:

```text
npm install -g web-codex-orchestrator
cd repository
wco
→ exactly one browser authorization on first use
→ thereafter only goals/prompts
```

Architecture:

```text
FIRST AUTHORIZATION

WCO local
  |
  | device id + nonce + PKCE S256 challenge
  v
maintainer-operated WCO Web service
  |
  | one verification_uri_complete
  v
browser → user Authorize once
  |
  v
scoped WCO access/refresh credential

NORMAL TASK

user prompt
  |
  v
WCO local durable job
  |
  v
managed WCO control plane / relay
  |
  v
maintainer-configured ChatGPT Web / Workspace Agent
  |
  | bounded semantic envelope
  v
WCO local Harness
```

The end user never provisions the hosted control plane, OAuth backend, ChatGPT App/MCP connector, Workspace Agent, trigger credentials or provider infrastructure. Those are service-owner release responsibilities.

The local device credential is scoped, owner-protected and stored outside repositories. Refresh is silent. Revocation may require the same one-link authorization again; it never exposes provider credentials or infrastructure configuration to the end user.

### Automatic semantic turns

Managed mode is zero-browser after authorization:

```text
createAuthoringJob
→ managed control plane automatically triggers original Web-A
→ Web-A submits bounded contract/implementation authority
→ Harness apply + verify
→ exact review evidence registered
→ managed control plane automatically triggers independent Web-B for PAIR
→ managed control plane automatically resumes original Web-A for final intent review
→ READY_FOR_YOU
```

The managed service must retain the original author conversation/intent identity for final review and use a distinct identity for independent Web-B. Trigger requests are idempotency-bound. A suspended/failed Agent or a completed run that did not submit the required semantic output is an operator/service defect and fails closed; WCO must never ask the normal user to open ChatGPT or approve/configure tools per task.

### Managed service readiness

The package can advertise the normal one-link flow only when operator metadata and the hosted service prove:

- ChatGPT/account authorization backend ready;
- Senior Architect/App/Agent configuration ready;
- automatic Agent trigger ready;
- scoped device registration/token/refresh/revoke ready;
- exact relay protocol compatible.

If not, WCO reports an operator/release blocker such as `WEB_MANAGED_OPERATOR_NOT_READY` or `WEB_MANAGED_DEPLOYMENT_REQUIRED`. It does not redirect end users to Cloudflare, native tunnel setup, browser automation or manual artifacts.

## Advanced official `web_native_mcp`

Secure MCP Tunnel remains a supported explicit advanced/operator profile:

```text
wco web connect --native
```

```text
WCO local MCP
  ^
  | official openai/tunnel-client · outbound only
OpenAI Secure MCP Tunnel
  |
private ChatGPT MCP App / Workspace Agent
```

It is not the normal default because current provider setup exposes developer/operator controls such as tunnel IDs, runtime API credentials, App/MCP configuration and Workspace Agent credentials. Those are forbidden in the normal-user UX budget.

The native MCP adapter still exposes only bounded exact reads and semantic submit capabilities. It cannot write the worktree, execute shell/Git, verify, publish, merge, deploy or release.

## Optional compatibility transports

Explicit advanced profiles remain:

```text
web_native_mcp   → official Secure MCP Tunnel/operator profile
personal_actions → Custom GPT Action + Bearer RelayProtocol endpoint
actions_relay    → legacy self-hosted Bearer profile
manual_file      → offline/manual compatibility
```

No failed normal managed connection may silently switch to one of these profiles. The optional Cloudflare Worker is only a reference adapter for an advanced `personal_actions` user.

## Context architecture

Repository context is progressive and exact:

```text
goal
→ exact repository identity/map/search
→ ranked relevant paths/regions
→ bounded exact reads on demand
→ content-addressed references for unchanged bytes
→ diff/result deltas
```

Base commit, tree/blob SHA, Result digest, generation and contract digest identify immutable context. Local caches are disposable performance state. Canonical Git objects and durable read receipts are re-attested wherever context becomes mutation authority. Full exact reads/preimages remain required before replace/delete operations.

PAIR sends no model-review turn. AUTOPILOT retains exactly one adaptive Sol/Terra reviewer call by default. Harness and deterministic verification use zero model tokens.

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

Recovery follows the same hierarchy. A provider `success` flag cannot overrule changed Git, archive, PR, Result Bundle, review or digest identity.

## Mode-specific review authority

### PAIR

PAIR has no Codex/model-review dependency. After deterministic verification, an independent Web-B may APPROVE, ESCALATE or return bounded repair authority. Harness applies/reverifies any repair. Original Web-A remains mandatory final intent reviewer.

```text
PAIR model/Codex reviewer calls = 0
Harness model tokens            = 0
```

### AUTOPILOT

AUTOPILOT uses exactly one frozen Sol/Terra reviewer on the normal path. It has read/review authority only and may return a complete bounded repair set in that same call; Harness validates/applies/reverifies it.

Original Web-A final review remains mandatory. A final Web-A REVISE is Web-proposed + Harness-applied, fast-forwards the same Draft PR, creates a new immutable result generation, and returns to Web-A. It never invokes Sol/Terra a second time.

## Harness owns every mutation

Web/model reviewers can propose only closed bounded operations (`create_file`, `replace_file`, `delete_file`) with exact path/preimage/postimage identity. The same Harness transaction machinery owns worktree writes, rollback, repair checkpoints and exact digest calculation regardless of who proposed the change.

Managed control plane, MCP, Workspace Agent, GPT Action, relay and manual-file transports can only deliver semantic envelopes. None receives shell/filesystem/Git authority.

## Fail-safe defaults and recovery

Ambiguity is a stop condition. Security-sensitive state is revalidated where it becomes authority.

- unsupported/malformed semantic authority fails closed;
- provider/auth/service failures never enable another transport automatically;
- Git/GitHub identities are re-attested before irreversible boundaries;
- missing isolation never falls back to unrestricted host execution;
- already-durable provider/network results are reused rather than blindly replayed;
- ambiguous external call outcomes are not blindly repeated.

A push is adopted only after expected remote SHA is observed. A Draft PR becomes authority only after repository/base/head/draft state are re-attested. Result Bundles and Web verdicts bind exact published head. Repairs bind the exact generation they answer.

## Parallel reads, serialized authority

Independent exact reads, context ranking and safe attestations may run concurrently. Mutation, artifact selection, repair adoption, commit/push, publication promotion and lifecycle state transitions remain serialized.

## Human boundary

Neither PAIR nor AUTOPILOT automatically merges, marks ready, enables auto-merge, force-pushes, deploys, tags, publishes npm or releases. `READY_FOR_YOU` means the exact result is ready for human review; it is not shipment authority.

## Product entry point

```text
npm install -g web-codex-orchestrator
cd repository
wco
→ first use: exactly one WCO authorization link
→ goal
→ reviewed Draft PR
→ READY_FOR_YOU
→ human merge/release
```

See [frozen user experience contract](user-experience-contract.md), [web bridge](web-bridge.md), [ADR 0003](adr/0003-one-link-managed-default.md), [job modes](job-modes.md), [operations](operations.md) and [protocols](protocols.md).