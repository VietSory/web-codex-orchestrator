# Architecture

WCO is a durable local control plane between provider-generated bounded engineering authority and a human-owned Git merge decision. Correctness is based on exact identities, closed schemas, deterministic verification and durable receipts—not on provider UI state, conversational continuity or a hosted WCO service.

## Normal PAIR system boundary

```text
user goal
   ↓
WCO / WSL
   ↓
ChatGPT Web author through WCO Windows companion
   │  prepared prompt + bounded mode only
   ↓
bounded exact repository reads executed by WCO
   ↓
sealed contract + bounded implementation authority
   ↓
Harness validation + isolated worktree mutation
   ↓
deterministic verification / repair
   ↓
independent ChatGPT Web code review
   ↓
exact Git/GitHub publication evidence + Draft PR
   ↓
original ChatGPT Web final intent review
   ↓
READY_FOR_YOU
   ↓
human merge / release
```

Normal repository/worktree state, exact-read receipts, Task/Result Bundles, mutation authority, verifier state, Git state and recovery state remain in WSL/local WCO authority.

## Browser companion boundary

The normal PAIR semantic transport is a first-party native Windows executable:

```text
WCO / WSL
  -> versioned bounded JSONL stdin/stdout
  -> WCO-owned Windows browser companion
  -> loopback-only Windows Chrome/Edge CDP
  -> ChatGPT Temporary Chat
```

The companion receives only prepared prompt text plus bounded model metadata and request identity. It does not receive repository/worktree paths, arbitrary commands, Git authority, Task/Result Bundle authority, cookies/tokens or arbitrary CDP parameters.

Browser/CDP control stays native on Windows. WSL never connects to the browser's CDP endpoint.

The companion uses a WCO-owned persistent browser profile for ChatGPT session continuity and creates a fresh Temporary Chat for each semantic/review turn. WCO never copies the user's ordinary browser profile or provider credentials.

## Provider selection

Trusted repository config intentionally has no `web_bridge` field for the normal path. Provider choice is owner-local preference state:

```text
chatgpt-web  -> default; first-party browser companion
codex        -> explicit alternative
```

Missing provider preferences are an upgrade/recovery state and resolve to `chatgpt-web`, not permission to spend Codex quota.

For PAIR with `chatgpt-web`:

```text
Codex authentication      = not required
Codex provider/model turns = 0
```

AUTOPILOT may additionally use one selected Sol/Terra reviewer and therefore requires the corresponding Codex runtime/authentication for that reviewer only.

## Exact repository context

The semantic provider is not a filesystem/Git agent. Repository context is progressive and exact:

```text
goal
→ repository identity / summary / bounded tree or search
→ focused exact file or byte-region reads
→ content-addressed reuse for unchanged bytes
→ sealed contract
→ implementation/result deltas
```

WCO executes repository reads itself against the exact bound repository/base. Sensitive-path, traversal/symlink and read-bound checks remain local.

Disposable summaries/indexes may improve localization but are advisory. Authority returns to canonical Git/file bytes and exact SHA receipts before mutation.

## Implementation authority

ChatGPT Web may produce only bounded, schema-valid engineering authority. It does not write the worktree directly.

WCO/Harness revalidates:

- protocol/job/run identity;
- task/contract binding;
- allowed path scope;
- forbidden/sensitive paths;
- exact preimages;
- canonical postimage bytes and SHA-256;
- operation/payload bounds.

Only validated authority reaches the isolated mutation machinery.

A durable provider-turn reservation is written before authority-bearing calls. If a crash leaves an ambiguous unsealed call, WCO fails closed instead of blindly replaying a second conflicting proposal.

## Harness and verifier authority

Harness/executor is the only component that may:

- mutate the isolated worktree;
- execute repository validation commands;
- calculate authoritative change-set digests;
- apply bounded repairs;
- create Git commits/pushes through WCO policy;
- drive Draft-PR publication state.

Provider output never directly writes files, executes shell/Git mutation, pushes, merges, tags, deploys or releases.

Deterministic verification is mandatory before reviewed/published state advances. Missing sandbox/isolation never falls back to unrestricted host execution.

## PAIR review identity

PAIR has two distinct ChatGPT Web review purposes:

```text
Web-B  independent code review
Web-A  original-author final intent review
```

Each review is bound to exact durable job/run/result/change evidence. A verdict may return only closed bounded authority. Harness applies and re-verifies accepted repairs.

The original Web-A final intent review remains mandatory after exact publication evidence. A stale verdict cannot authorize a moved digest/HEAD.

## AUTOPILOT

AUTOPILOT starts from the same Web-authored bounded implementation flow, then adds one frozen Sol/Terra adaptive reviewer pass. The model reviewer has no direct mutation authority; repairs return through Harness plus deterministic re-verification.

AUTOPILOT does not grant merge/release authority and does not change PAIR's zero-Codex requirement.

## Failure boundary

First-party browser PAIR is fail-closed:

- missing companion artifact/setup -> block;
- missing Windows browser -> block;
- ChatGPT sign-in/session unavailable -> block;
- unexpected origin/Temporary Chat proof -> block;
- model selector ambiguity -> block;
- protocol mismatch -> block.

None of those conditions silently activates Codex, a legacy browser helper, a relay, MCP, managed Web or manual-file transport.

## Durable state and replay

WCO-owned durable state is the recovery authority, subject to re-attestation of stronger evidence:

- author/review job identities;
- repository-command receipts;
- sealed contracts;
- canonical task/run identities;
- provider-turn reservations and sealed outputs;
- executor/verifier checkpoints;
- selected artifacts/change-set digests;
- Git/GitHub publication evidence;
- Result Bundle and final verdict bindings.

Already sealed authority may be reused idempotently. Ambiguous authority-bearing provider/network outcomes are not blindly replayed.

## Authority hierarchy

From stronger to weaker authority:

1. trusted WCO configuration + owner-local provider preference;
2. canonical accepted task/run identity + sealed contract;
3. exact Git repository/base/tree state + read receipts;
4. validated implementation/repair authority with exact preimage/postimage identity;
5. Harness transaction state + deterministic verification bound to exact digests;
6. code-review evidence bound to those digests;
7. exact Git/GitHub publication, Draft PR and Result Bundle evidence;
8. final intent verdict bound to exact durable intent/result evidence;
9. orchestration receipts re-attested against stronger evidence;
10. provider thread/status/UI state and disposable caches.

A provider `success` flag or visible browser page cannot overrule changed Git, archive, PR, Result Bundle, review or digest identity.

## Advanced compatibility transports

Explicit compatibility/operator profiles may remain:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

They are never the fresh default and never an automatic fallback from first-party browser PAIR.

## Human shipment boundary

Neither PAIR nor AUTOPILOT automatically merges, marks a PR ready, enables auto-merge, force-pushes protected branches, deploys, tags, publishes npm or creates a release.

`READY_FOR_YOU` means the exact reviewed Draft PR is ready for a human decision. It is not shipment authority.

## Release qualification

Automated CI can prove protocol, build, deterministic verification, fail-closed behavior and Windows executable/checksum integrity. It cannot prove a real signed-in ChatGPT account/browser session.

Release qualification therefore requires both:

1. exact-head automated Main + Advanced + Windows companion gates; and
2. real signed-in Windows/WSL PAIR dogfood proving zero Codex provider turns and exact reviewed HEAD publication.
