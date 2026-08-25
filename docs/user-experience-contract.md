# Frozen normal-user experience contract

This document is the release-acceptance contract for WCO's normal single-user PAIR path. Historical phase documents, superseded ADRs and optional compatibility transports do not override it.

## Supported normal PAIR environment

The current first-party ChatGPT Web PAIR architecture is designed for **WSL on Windows**:

```text
WCO / WSL
  -> WCO-owned Windows browser companion
  -> loopback-only Chrome/Edge CDP
  -> real ChatGPT Temporary Chat
```

WSL is the deterministic execution host. Native Windows is only the bounded browser-transport host. The normal PAIR prerequisites are:

- Windows + WSL with Windows interop enabled;
- Node.js 22+ and npm in WSL;
- Git;
- Bubblewrap;
- Windows Chrome or Edge;
- a ChatGPT account;
- GitHub CLI authentication when Draft-PR delivery is requested.

Native Linux can execute WCO's Linux verification path, but the current first-party ChatGPT Web companion is Windows-native. A Linux user without Windows interop must explicitly select another supported provider such as `codex`; that is not the zero-Codex PAIR contract described here.

## End-user install

After a human maintainer publishes a qualified release, the normal user installs the exact packaged `.tgz` in WSL:

```bash
npm install -g ./web-codex-orchestrator-<version>.tgz
cd /path/to/project
wco
```

GitHub `Source code (zip)` / `Source code (tar.gz)` snapshots are not the normal-user package. Normal users do not clone WCO or run its development build.

## Default provider selection

Fresh setup defaults owner-local provider preferences to:

```json
{ "schema_version": "1.0", "provider": "chatgpt-web" }
```

Trusted repository config intentionally contains **no `web_bridge` field** for the normal path. Provider preference is owner-local UX state, not repository authority.

Only an explicit persisted `provider: "codex"` selects the Codex semantic provider. Missing preferences are treated as upgrade/recovery state and resolve to ChatGPT Web, so absence never becomes permission to spend Codex quota.

## First ChatGPT sign-in

PAIR does not delegate provider authorization to Codex.

WCO bootstraps its first-party Windows companion, verifies the companion SHA-256, and uses a WCO-owned persistent browser profile. If ChatGPT sign-in is required, the user completes it in that WCO browser window.

WCO must not ask the normal PAIR user to copy or enter:

- a ChatGPT/OpenAI API key;
- ChatGPT cookies or OAuth tokens;
- an existing browser profile;
- tunnel IDs or runtime keys;
- relay endpoints/secrets;
- a Custom GPT/OpenAPI Action;
- an MCP App/connector;
- a Workspace Agent identifier;
- a custom domain or hosted WCO service.

The browser profile is session continuity only. It is never repository, mutation or shipment authority.

## Daily PAIR workflow

After sign-in/readiness:

```bash
cd /path/to/project
wco
```

Then type a goal, for example:

```text
Add rate limiting to login and add regression tests.
```

Healthy PAIR budget:

```text
Codex provider authentication         = 0
Codex provider/model turns            = 0
per-task manual browser interactions  = 0
per-task credential inputs            = 0
per-task infrastructure setup         = 0
automatic merge/release               = 0
```

The companion still performs browser automation for each provider/reviewer turn. Each turn must use a fresh ChatGPT Temporary Chat.

The successful terminal product state is `READY_FOR_YOU` with an exact reviewed Draft PR. The human alone decides merge/release.

## PAIR authority flow

```text
user goal
  -> ChatGPT Web author through WCO companion
  -> bounded exact repository reads executed by WCO
  -> sealed contract + bounded implementation authority
  -> Harness validation + isolated mutation
  -> deterministic verification / repair gates
  -> independent ChatGPT Web code review
  -> exact Draft PR + Result Bundle evidence
  -> original ChatGPT Web final intent review
  -> READY_FOR_YOU
  -> human merge/release
```

The Windows companion receives only prepared prompt text plus bounded model metadata/request identity. Repository/worktree paths, shell/tool commands, Git authority, Task/Result Bundle authority, cookies/tokens and arbitrary CDP parameters are forbidden at that protocol boundary.

ChatGPT Web output is not workflow authority until it passes WCO's closed schemas and exact repository/job/run/path/digest binding.

Harness remains the only mutation authority. Provider output never directly writes files, executes shell/Git mutation, pushes, merges, tags, deploys or releases.

## Review split

PAIR has two Web review roles:

- **Web-B**: independent code review for correctness, security, regressions, tests, scope and performance;
- **Web-A**: original-author final intent review against the exact published result.

Both reviews are bound to exact durable evidence. A repair proposal is bounded; Harness applies it and deterministically re-verifies the new digest.

A moved/repaired digest requires fresh exact-digest Web approval before `READY_FOR_YOU`.

## Fail-closed transport contract

The following conditions must block PAIR:

- companion executable missing/unavailable;
- Windows interop/setup destination unavailable;
- Chrome/Edge unavailable;
- ChatGPT session/sign-in unavailable;
- unexpected ChatGPT origin or Temporary Chat proof;
- model selector ambiguity;
- companion protocol mismatch;
- deterministic verification isolation unavailable.

PAIR must **never silently fall back** to:

- Codex provider/model turns;
- a legacy browser helper;
- direct WSL -> Windows CDP;
- relay/managed/manual compatibility transports;
- copied credentials or private undocumented provider APIs.

## Continuation and saved-task mental model

- `/continue` continues only the current unfinished saved task and never switches to history implicitly.
- `/resume` without a number presents saved-task selection; `/resume <number>` explicitly selects that history item.
- `/history` is read-only inspection.
- completed tasks stay complete; follow-up work receives a new task/run identity.
- switching unfinished focus requires confirmation bound to the exact current session.

The legacy `/run` spelling may remain parser-compatible, but normal guidance teaches `/continue`.

## AUTOPILOT boundary

AUTOPILOT is explicit and may require one selected Sol/Terra reviewer pass. That reviewer uses Codex runtime/auth/quota according to its frozen run selection.

AUTOPILOT's reviewer requirement must never leak into PAIR readiness or provider turns.

## Advanced compatibility profiles

`web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, and `manual_file` are explicit advanced/compatibility profiles only. None may become an implicit fallback or change the fresh normal PAIR contract.

## Machine-auditable PAIR budget

```text
WCO-hosted services                   = 0
third-party relay/cloud setup         = 0
public localhost/inbound ports        = 0
API/tunnel/relay keys entered         = 0
MCP/App/Workspace Agent setup         = 0
copied browser credentials            = 0
Codex provider turns                  = 0
per-task manual browser interactions  = 0
per-task authorization/config         = 0
automatic merge/release               = 0
```

## Release qualification

A release/audit agent must reject first-party PAIR release readiness until both are true:

1. exact-head automated Main, Advanced and Windows companion gates pass; and
2. a real signed-in Windows/WSL PAIR dogfood proves first-party companion use, zero Codex provider turns, exact reviewed HEAD publication, repair/re-review binding where exercised, and human-only merge/release.

Synthetic CI is not proof of a real signed-in ChatGPT browser session.
