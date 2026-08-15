# Frozen normal-user experience contract

This document is the release acceptance contract for WCO's normal single-user path. Historical phase documents and optional compatibility transports do not override it.

## End-user steps

After a human maintainer publishes a qualified GitHub Release, the normal user downloads the packaged WCO `.tgz` artifact and installs that exact release once:

```bash
npm install -g ./web-codex-orchestrator-<version>.tgz
cd /path/to/project
wco
```

The GitHub `Source code (zip)` / `Source code (tar.gz)` snapshots are not the normal-user package. Normal users do not clone WCO or run its development build.

On first interactive use only, WCO hands authorization to its **bundled official Codex runtime**, which performs the normal ChatGPT browser sign-in. Codex owns the OAuth callback, credential storage and token refresh lifecycle. WCO never asks the normal user to copy or enter a ChatGPT/OpenAI API key, tunnel ID, runtime key, endpoint, bearer token, cookie, browser profile, MCP connector, Workspace Agent identifier, domain or relay configuration.

After that authorization succeeds, daily use is only:

```bash
cd /path/to/project
wco
```

and a goal, for example:

```text
Add rate limiting to login and add regression tests.
```

Per-task browser interactions = 0. If the provider later expires or revokes the ChatGPT session, WCO may request the same official ChatGPT authorization again; it must never recover by asking for an API key, tunnel, relay, connector or hosted WCO service.

The successful terminal product state is `READY_FOR_YOU` with an exact reviewed Draft PR. The human alone decides merge/release.

## Zero-config local transport

A fresh normal-user config intentionally contains **no `web_bridge` field**. Absence is the effective local ChatGPT/Codex transport. Explicit `web_bridge` profiles are advanced compatibility overrides only.

All WCO-owned engineering authority/state remains on the user's machine:

- repository and isolated worktree state;
- durable task/session state and receipts;
- exact repository-context cache/read coverage;
- local semantic mailbox;
- Task Bundles and Result Bundles;
- Harness mutation authority;
- deterministic verifier/sandbox state;
- Git/Draft-PR recovery state.

The bundled official Codex runtime communicates outbound to OpenAI using the user's ChatGPT authorization. WCO does not operate a normal-path server, database, relay, mailbox service or hosted control plane.

## Authority split

The normal pipeline is:

```text
user goal
  -> local semantic author (read-only)
  -> bounded exact RepositoryCommand reads
  -> sealed WCO contract
  -> canonical prepared run
  -> Harness-side Codex implementation proposal (read-only proposal)
  -> WCO validation + Harness mutation/execution
  -> deterministic verification / repair gates
  -> independent semantic final review
  -> exact reviewed Draft PR
  -> human merge/release
```

Semantic author/reviewer turns have no repository mutation, Git, publish, merge, deployment, credential or network-tool authority. Provider output is not workflow authority until it passes WCO's closed local validators and exact job/run/digest binding.

The implementation planner proposes bounded file operations only. WCO/Harness validates path policy, content digests, exact preimages, task/run binding and verifier gates before repository mutation can occur. There is no model-controlled direct publish or merge path.

## Forbidden normal-user infrastructure

The normal path must never require the user to configure:

- a WCO-hosted backend, database or managed WCO service;
- Cloudflare;
- ngrok;
- a VPS;
- a custom domain or DNS;
- AWS or another third-party cloud relay;
- a user-hosted OAuth server;
- public localhost/workstation ingress;
- WCO relay secrets;
- a ChatGPT/OpenAI API key;
- an OpenAI tunnel ID or tunnel runtime key;
- a Custom GPT/OpenAPI Action;
- an MCP App/connector or Workspace Agent;
- copied ChatGPT cookies or browser profiles;
- manual task/result ZIP handoff;
- run IDs or internal phase commands.

Optional compatibility profiles may expose some of those concepts only after an advanced user deliberately selects that profile. WCO must never auto-fallback to one after local ChatGPT authorization/runtime failure.

## Authentication boundary

The normal authorization mechanism is the bundled official Codex ChatGPT login flow. WCO may invoke that flow and verify `login status`; WCO must not parse, duplicate, export or independently persist the resulting ChatGPT OAuth credential.

Fresh first run in CI/headless mode must never open a browser or claim authorization succeeded. Interactive first use may open the official browser authorization exactly once. A failed or interrupted authorization fails closed and can be retried with `wco` or `wco web connect`.

## Exact repository context and recovery

Semantic authoring uses progressive, bounded repository context rather than full-repository transmission. Exact reads are bound to the sealed Git base and digest receipts. Disposable summaries/indexes may improve localization, but they can never authorize mutation; authoritative content must return to exact Git/file reads and SHA receipts.

Provider/model calls that can affect durable authority must be idempotency-bound or fail closed when a crash makes replay ambiguous. Recovery must never silently generate a second conflicting mutation proposal.

Both PAIR and AUTOPILOT preserve exact Git/digest/evidence binding, isolated mutation, deterministic verification, same-Draft-PR repair/recovery and the human-only shipment boundary. Agent-turn and token budgets remain bounded by trusted configuration; no mode may bypass those limits.

## Machine-auditable normal-user budget

After the initial ChatGPT authorization:

```text
WCO-hosted services                 = 0
third-party relay/cloud setup       = 0
public localhost/inbound ports      = 0
API/tunnel/relay keys entered       = 0
MCP/App/Workspace Agent setup       = 0
copied browser credentials          = 0
per-task browser interactions       = 0
per-task authorization/config       = 0
automatic merge/release             = 0
```

## Compatibility profiles

`web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, and `manual_file` are explicit advanced/compatibility profiles only. They may remain tested for existing users, but none may become an implicit fallback or change the fresh normal-user contract above.

## Audit rule

A release/audit agent must treat any newly introduced mandatory normal-user infrastructure outside this document as a product defect. It must also reject claims of release readiness until the packed zero-config path and a real local one-authorization acceptance have both succeeded.

Local prerequisites remain Node.js 22+, npm, Git, the platform sandbox prerequisites required by the selected execution mode, and GitHub CLI (`gh`) authenticated when Draft-PR delivery is requested.
