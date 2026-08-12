# Architecture

WCO is a durable orchestration layer between untrusted external proposals and a human-owned Git merge decision. Correctness is based on exact identities and durable receipts, not on conversational continuity.

## System boundary

```text
Web-authored bounded authority
        ↓
validation + content identity
        ↓
WCO-owned isolated state/worktree
        ↓
Harness mutation + deterministic verification
        ↓
mode-specific code review
  PAIR: independent Web-B
  AUTO: one frozen Sol/Terra pass
        ↓
exact Git/GitHub publication evidence
        ↓
original Web-A final intent verdict
        ↓
human merge authority
```

The browser, ChatGPT/Codex transcripts, model thread history, terminal output, and derived caches are transport or diagnostic surfaces. They never become lifecycle authority.

## Web transport profiles

```text
ChatGPT Web / Senior Architect
             |
          GPT Action
             |
   +---------+----------+
   |                    |
personal_actions   managed_actions       manual_file
Bearer / 1 owner   OAuth / accounts      offline files
   |                    |
small mailbox      managed relay
   +---------+----------+
             ^
      outbound WCO local -> Harness -> verifier -> PAIR/AUTOPILOT
```

Transport selection cannot grant mutation, verification, publication or merge authority. The relay stores only bounded authenticated events with TTL and idempotency identity; it has no repository, Git, shell or lifecycle capability. `actions_relay` is a preserved alias/profile spelling for existing personal bearer configuration.

Repository context is progressive: compact map, ranked paths, exact regions/files on demand, then result/diff deltas. Base commit, tree/blob SHA, Result digest, generation and contract digest identify immutable context. A disposable content-addressed cache suppresses repeated bytes, but canonical Git objects and durable receipts are always re-attested where context becomes authority. PAIR transmits no model-review turn; AUTOPILOT retains exactly one adaptive reviewer call by default; Harness model tokens remain zero.

## Authority model

From highest to lower authority:

1. trusted WCO configuration and registered repository policy;
2. canonical accepted Task Bundle and run identity;
3. exact Git repository/base/tree state;
4. immutable registered Web artifacts and exact operation preimages/postimages;
5. Harness transaction/repair checkpoints and deterministic verification bound to an exact change-set digest;
6. mode-specific code-review evidence bound to that digest;
7. exact Git/GitHub publication, Draft PR and Result Bundle evidence;
8. original Web-A final verdict bound to the freshly attested published head;
9. durable orchestration receipts that may advance only after re-attesting stronger evidence above;
10. logs, UI/session state and caches.

Recovery follows the same hierarchy. A persisted `success` flag cannot overrule changed Git, archive, PR, Result Bundle or review identity.

## Mode-specific review authority

PAIR has **no Codex dependency**. After deterministic verification, an independent Web-B code-review identity can approve, escalate, or return bounded repair operations. Repairs are applied/reverified by the Harness. The original Web-A session remains a separate final intent reviewer.

AUTOPILOT uses exactly one frozen Sol/Terra reviewer on the normal path. That reviewer is read/review authority only. A local blocking correction may be returned as bounded repair operations in the same call; the Harness validates/applies/reverifies them. The original Web-A final review remains mandatory.

A final Web-A `REVISION_REQUESTED` is Web-proposed + Harness-applied in both modes. It fast-forwards the same Draft PR, produces a new immutable revision Result Bundle, and returns to Web-A. AUTOPILOT does not invoke Sol/Terra a second time.

Legacy model-owned Phase 4/Phase 8 code remains compatibility surface for older prepared runs, not normal product authority.

## Design principles

### Harness owns every mutation

Web/model reviewers can propose only closed, bounded operations (`create_file`, `replace_file`, `delete_file`) with exact path/preimage/postimage identity. The same Harness transaction machinery owns worktree writes, rollback, repair generation checkpoints and exact digest calculation regardless of who proposed the change.

This prevents a reviewer from becoming a hidden implementer with unrestricted shell or filesystem authority.

### Fail-safe defaults and complete mediation

Ambiguity is a stop condition. Security-sensitive accesses are revalidated where their result becomes authority, including recovery and publication.

Applied in WCO:

- unsupported/malformed authority fails closed instead of guessing;
- Git/GitHub identities are checked again before an irreversible boundary;
- Web/model, verifier, Git and GitHub capabilities remain separated;
- dangerous actions stay outside the autonomous command set;
- missing isolation never falls back to unrestricted host execution.

These choices align with the protection principles described by Saltzer and Schroeder: fail-safe defaults, complete mediation, least privilege and separation of privilege.

Reference: https://web.mit.edu/saltzer/www/publications/protection/index.html

### End-to-end correctness

Lower layers validate their own work, but the orchestration endpoint still verifies the property that matters to the workflow.

Applied in WCO:

- a push is adopted only after the expected remote SHA is observed;
- a Draft PR is authority only after repository/base/head/draft state are re-attested;
- a Result Bundle and Web verdict are bound to the exact published head;
- a repair is bound to the exact review/result generation it answers;
- crash recovery re-attests completed side effects rather than replaying them blindly.

Reference: https://web.mit.edu/saltzer/www/publications/endtoend/endtoendA4.pdf

### Write-ahead recovery around side effects

WCO persists the smallest durable authority required before an external side effect. For final Web revisions, the previous-head→repaired-worktree delta and approved snapshot are checkpointed before publication. A crash after commit/push can therefore adopt exact durable publication state without reconstructing trust from a worktree whose HEAD has already advanced.

Recovery prefers receipt adoption over repeating a model turn, commit, push, PR creation or bundle build. This reduces duplicate side effects, latency and token cost.

### Bounded resources

Every potentially adversarial or long-lived surface has an explicit bound: archive entries/bytes, JSON receipts, subprocess output/time, retries, event records, candidate scanning, model turns/tokens, repair generations and concurrency. Bounds are part of correctness, not only performance tuning.

### Parallel reads, serialized authority

Independent repository reads, research, evidence collection and safe attestations may run concurrently. Mutation, artifact selection, repair binding, publication promotion and lifecycle authority transitions are serialized. WCO does not increase agent count merely to increase nominal parallelism when that would create context/coordination overhead or conflicting writes.

### Content-addressed evidence

Stable artifacts are named and compared by hashes or immutable Git identities wherever practical. Derived project maps and caches may accelerate work, but deleting a cache must never change an authorization decision.

## Human boundary

Neither PAIR nor AUTOPILOT automatically merges, marks a PR ready, enables auto-merge, force-pushes, directly pushes protected branches, deletes remote branches, deploys or releases. `READY_FOR_YOU` is evidence-backed readiness for human review; it is never merge authority.

## Secure development and release references

WCO release engineering should continue to align with established software-supply-chain guidance:

- NIST SSDF SP 800-218: integrate secure-development practices throughout the lifecycle. https://csrc.nist.gov/pubs/sp/800/218/final
- SLSA: attach verifiable provenance to release artifacts. https://slsa.dev/spec/v1.2/provenance
- The Update Framework (TUF): consider delegated, rollback-resistant update metadata if WCO later gains an automatic updater. https://theupdateframework.io/spec/
- Command Line Interface Guidelines: keep the CLI human-first, concise by default and composable through stable machine output. https://clig.dev/

These references guide boundaries and release engineering; they are not compliance claims.

## Product entry point

The interactive TUI and Web bridge are adapters over durable orchestration services, not a second authority state machine. ChatGPT Web submits untrusted semantic envelopes through a transport-only relay. Local materializers bind exact Git objects, accepted artifact hashes and read receipts before invoking canonical intake/preparation, Web authority, Harness execution, publication, Result Bundle and review services. See [web-bridge.md](web-bridge.md) and [job-modes.md](job-modes.md).
