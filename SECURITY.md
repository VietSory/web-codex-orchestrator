# WCO Security Model

WCO is built around one rule: **authority must be explicit, bounded and reproducible**. A model response, chat message, filename, latest artifact or previous success is never enough by itself to authorize a mutating action.

## Trust hierarchy

From highest to lower authority:

1. trusted local WCO configuration and repository registry;
2. canonical Phase 3 run receipt + exact accepted Task Bundle;
3. exact Git repository/base/tree identity;
4. immutable registered Web artifacts and their hash bindings;
5. deterministic verifier/reviewer evidence bound to an exact change-set;
6. mutable orchestration receipts, indexes, caches and UI/session state.

Mutable receipts are progress checkpoints. Where externally derivable identity exists, WCO re-derives and rebinds it before continuing.

## Threat assumptions

WCO defends against untrusted downloaded artifacts, malformed archives/JSON, traversal, symlink/path redirection, stale/tampered checkpoint fields, bounded-I/O exhaustion, Git/GitHub drift, stale review authority, partial crashes and unintended tool/model scope expansion.

WCO does **not** claim cryptographic protection against an attacker who has unrestricted control of the same OS account and can arbitrarily replace WCO binaries/source, trusted configuration, repository contents and all state simultaneously. Local state still receives defensive integrity/path checks because accidental corruption, partial compromise and race/path replacement must fail closed.

The canonical Phase 3 worktree is a WCO-owned isolated execution surface. While an executor transition holds its WCO lock, no user/editor/third-party process is expected to mutate that worktree concurrently. WCO re-attests exact preimages immediately before writes, exact postimages after writes, the closed-world changed-path set and the final bytes/modes before every approval. Portable Node filesystems do not provide a cross-platform compare-and-swap primitive that can synchronize an unrelated external writer between those checks and an atomic replace; therefore concurrent out-of-band writers are explicitly unsupported rather than silently treated as safe. A user should edit the source repository/normal worktree, not the WCO isolated worktree.

Secrets must not be embedded in task/Web artifacts or persisted review evidence. Production model/sandbox processes receive only the minimum trusted environment required by their adapters.

## Downloaded Task Bundles and Phase 4 runtime

Downloaded bundles are untrusted. Accepted bundle content is metadata/context; archive payload entries are never executed as programs by intake or the Phase 10 executor.

Production Codex execution uses the WCO-pinned bundled runtime. The global `codex` executable is not selected as implementation authority. Verification runs through the pinned workspace sandbox with network disabled; there is no unsandboxed fallback. Validation commands come from the accepted Task Bundle/trusted policy and use structured executable/argv values rather than shell interpolation.

Verifier/reviewer output is bounded/redacted before persistence or reuse.

## Phase 7 — Web verdict authority

A Web verdict is accepted only after independently verifying the exact Result Bundle and its embedded review contract/schema/spec set. Verdict bytes are bounded, regular non-symlink files read with stable file identity/size checks.

Every terminal decision receives fresh read-only GitHub attestation. The PR must still be open, unmerged and Draft with exact repository/head/base branch and SHA identity. Terminal retry does not reuse stale GitHub authority.

Phase 7 does not commit, push, update a PR, mark Ready or merge.

## Phase 8 — Same-PR revision publication

Phase 8 consumes only the canonical sealed `REVISION_REQUESTED` produced by Phase 7. The accepted Task Bundle is re-attested against previously sealed authority and mutable revision receipts are rebound to canonical Phase 3/7/config identity on resume.

Before an actual push, Phase 8 rechecks the accepted bundle and the same open/unmerged Draft PR. It permits only one normal fast-forward revision commit on the existing branch; no force-push, amend, rebase, branch deletion, new PR, mark-ready or merge path exists.

### Clean Git transport

Worktree-local Git URL rewrite rules must not be able to redirect credentials/publication. Network `ls-remote`/push therefore use clean temporary bare Git transport contexts rather than loading the product worktree's local config. Push uses the already-created commit objects read-only through Git object alternates. Temporary transport state is removed after the operation.

Result Bundle v1.2 chains the previous Result Bundle/receipt, Web verdict, revision request, previous commit/head, spec set and PR number. Review rounds 2..4 must consume revision bundles 1..3 respectively; no fallback to an older bundle is permitted.

## Phase 9 — Web Authority Protocol v2

Phase 9 turns a Web implementation ZIP into implementation authority only after all of the following agree:

- canonical Phase 3 run/task/Task Bundle identity;
- configured repository ID and branch;
- exact base commit and Git tree;
- clean canonical worktree;
- repository inventory/object IDs;
- read coverage/project map semantics;
- accepted Task Bundle spec-set hash;
- source receipts and frozen architecture/acceptance/prohibited-change documents;
- exact create/replace/delete operations;
- exact existing-file preimages and payload hashes.

The Artifact Registry is content-addressed. `registration.json` and the registered archive are bounded/no-follow reads with inode/device/size/path re-attestation. Status does not trust the registration record alone: it independently re-hashes/re-parses the immutable archive and rebinds the record to the archive manifest/repository/bindings.

Phase 9 writes only WCO state. It does not modify the product worktree, invoke an implementer, commit, push or mutate GitHub.

## Phase 10 — Code-First Constrained Executor

Phase 10 is a deterministic consumer of Phase 9 authority, not a second architect.

### Before product mutation

Production execution orders checks as:

```text
syntax/run identity
→ registration exists/matches
→ trusted config/run resolution
→ pinned Codex auth + verifier sandbox availability
→ fresh Phase 9 canonical authority/preimage revalidation
→ prepare transaction/backups
→ product writes
```

Thus cheap user/config/artifact errors fail quickly while runtime/auth/sandbox failures still occur before a partial product edit.

### Closed-world transaction

All operation preimages and backups are proven before the first write. Only registered create/replace/delete paths exist in the transaction. `.git/**`, traversal and symlink-crossing paths remain forbidden.

Executor receipt, backups and evidence are state-root confined, size-bounded and use stable no-follow reads. Crash resume may see only registered operation paths; unrelated worktree changes fail closed before another write. Each target must be exactly its registered preimage or postimage state; anything else is ambiguous external drift and escalates to Web authority.

The exact approved change-set binds:

- run/artifact/base identity;
- complete registered changed-path set;
- exact postimage bytes/absence;
- expected file permission mode.

A content-preserving chmod therefore invalidates the approved digest just like a byte mutation.

Mutable executor receipts are rebound to the registered Phase 9 transaction on resume. Persisted gate approvals must retain their exact immutable evidence files; missing/hash-drifted evidence is not accepted. `READY_FOR_PUBLISH` additionally requires verification, Terra and Sol approvals chained to the same exact digest.

### Model/tool least privilege

Phase 10 has **no implementer model turn**. WCO writes exact Web payload bytes with deterministic filesystem code. Codex is used only for the deterministic sandbox boundary and independent read-only Terra/Sol review.

Reviewer workspace access is read-only/no-network through the existing reviewer adapters. Prompts are bounded and contain the digest/changed-path scope plus the accepted Task Bundle location rather than a full prior implementation transcript. Reviewer output may reject/escalate but cannot authorize new operations or edit the worktree.

Phase 10 has no commit, push, create/update PR, mark-ready or merge capability.

## Phases 11–16 — Durable orchestration and external mutation safety

The outer controller is a state machine over canonical lower-layer receipts, not a replacement authority source. Before an external transition it SHA-256 seals the canonical request and persists a `STARTED` attempt. A late result must match the exact active attempt ID before it can advance the ledger.

One run has one transition-execution fence, with lower-layer locks still applied inside their own mutation boundaries. Retryable failures become durable `WAITING` state with a retry-not-before timestamp; they are not implemented as a polling loop. Total/per-transition attempts, elapsed time, recent events and diagnostics remain bounded.

Crash recovery does not equate missing tool/chat continuation with failure or success. It reconciles exact WCO/external evidence and adopts only terminal state bound to the same sealed request. This applies to registered artifacts, executor terminal receipts, pushed Git commits, Draft PR state, Result Bundles, Web verdict decisions and same-PR revision `RESULT_READY` receipts. Ambiguous or drifted evidence fails closed rather than blindly repeating an external mutation.

GitHub Draft-PR creation is intentionally Draft-only with `maintainer_can_modify=false`. Redirects are rejected rather than forwarding credentials across a changed destination. Response bodies and retained diagnostics are bounded and configured tokens are redacted from error text. GitHub primary/secondary rate-limit signals affect only retry timing: valid `Retry-After` is honored, primary reset time is used only when `X-RateLimit-Remaining` is `0`, and a recognized secondary limit without either condition receives the documented one-minute minimum wait. Required waits cannot exceed the remaining outer elapsed budget.

Phase 14 Web verdict authority remains bound to a freshly attested open/unmerged Draft PR head. Phase 15 revision authority additionally reloads the sealed Revision Request and binds review round, verdict digest, decision-event digest, prior published head and PR number. Revision crash adoption is permitted only for the exact durable `RESULT_READY` round; incomplete revision work remains on Phase 8's normal bounded resume path.

The outer ledger records model/input/output usage exactly where a lower-layer frozen receipt exposes it (currently completed Phase 8 revision receipts). Phase 10's frozen executor receipt does not expose token counters, so WCO does not fabricate them or claim global accounting for every lower-layer model call.

## Locks and crash recovery

Security-sensitive lifecycle locks use create-only ownership with a random nonce. Existing locks are not automatically stolen based on age because stale-lock deletion creates a replacement race. Manual recovery must establish that no live owner is using the state first.

Crash recovery is conservative: an ambiguous filesystem/Git/authority state escalates instead of guessing or resetting unrelated user work.

## Resource exhaustion and performance security

Performance limits are security limits. WCO applies hard caps to archive entries/bytes, receipts, evidence, diagnostics, process output, retries/turns, orchestration events and state reads. The GitHub REST client has a 1 MiB response-body cap; revision canonical artifacts have a 2 MiB cap. `continue` has a bounded transition count per invocation and durable retry/backpressure prevents hot loops.

`PERFORMANCE.md` defines the implemented concurrency, backpressure, session, context and token boundaries. WCO v1 reuses existing immutable/hash-bound artifacts but does **not** claim a separate repository-wide project-map cache subsystem where no executable implementation exists. Any future cache or derived index must remain non-authoritative, bounded and safely deletable/rebuildable.

## Upstream/native boundaries

`codex-chatgpt-web` browser/session/relay issues that WCO can shield become compatibility requirements in `UPSTREAM-COMPATIBILITY.md`. WCO does not patch OpenAI Codex app/CLI/agent internals. OpenAI-owned failures are handled through version/capability detection, durable checkpoints, bounded retry/backoff and actionable diagnostics.

Native Windows/WSL/browser/bridge behavior still requires the final local compatibility gate; repository CI cannot prove properties of the user's installed desktop/browser runtime.
