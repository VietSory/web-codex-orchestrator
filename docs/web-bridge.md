# ChatGPT semantic bridge

WCO keeps repository state, evidence, verification and mutation authority on the user's machine.

## Default: zero-config local ChatGPT/Codex

A fresh normal-user config has no `web_bridge` field. Absence selects WCO's local ChatGPT/Codex bridge backed by the pinned bundled official Codex runtime.

```text
user goal
  -> local semantic author (read-only)
  -> bounded exact repository reads
  -> sealed contract
  -> canonical prepared run
  -> Harness implementation proposal
  -> WCO validation + local mutation
  -> deterministic verification / repair
  -> independent semantic final review
  -> Draft PR
  -> human merge/release
```

There is no normal-path WCO server, relay, database, hosted control plane or public workstation endpoint.

## Authorization

First interactive use delegates to the official ChatGPT sign-in flow owned by bundled Codex. WCO does not copy browser state or independently store ChatGPT credentials.

After authorization, normal tasks require no browser action. `wco web connect` is the recovery command when ChatGPT authorization must be renewed. Status checks are passive and never open a browser.

## Semantic authority

The semantic author may request bounded `RepositoryCommand` context and seal a contract. It has no repository mutation, shell, Git, publish or merge authority.

Provider output is never trusted directly. WCO parses it through closed local schemas and verifies exact job, repository, run and digest bindings before it can affect workflow state.

Final semantic review is a separate review job and may return only a bounded verdict bound to the exact result evidence.

## Harness implementation

After the contract is sealed, WCO binds the job to the canonical prepared run. A separate Harness-side planner reads the accepted Task Bundle and isolated worktree in read-only mode and proposes bounded file operations.

WCO validates operation paths, postimage digests, exact preimages and job/run binding before Harness may mutate the worktree. Verification, Git and Draft-PR delivery remain local WCO authority.

A durable reservation is written before an implementation provider turn. If a crash leaves a reservation without a sealed result, WCO refuses an automatic replay rather than risk producing conflicting implementation authority.

## Durable local state

The local bridge reuses WCO's hardened owner-local mailbox primitives for atomic records, bounds, TTLs and idempotency. This is local durable state, not a network relay.

## Context efficiency

Context remains progressive:

```text
goal
  -> summary/tree/search
  -> focused exact file or region reads
  -> digest reuse
  -> contract
  -> implementation/result deltas
```

Advisory local summaries or symbol/reference indexes may improve localization, but authoritative content must return to exact Git/file reads and SHA receipts before mutation.

## Advanced compatibility profiles

Explicit compatibility profiles may remain available for existing users, including `web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, and `manual_file`.

They are never the fresh default and never a silent fallback from local ChatGPT/Codex.

## Doctor and recovery

With no explicit `web_bridge`, diagnostics report local ChatGPT/Codex readiness. Authorization/runtime failure is fail-closed. The normal recovery path remains the official ChatGPT sign-in flow; WCO must not silently switch transport.

Browser DOM automation, copied ChatGPT cookies/profiles, private ChatGPT endpoints and undocumented product APIs are not supported normal transports.
