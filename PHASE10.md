# Phase 10 — Registered Web Operation Application

Phase 10 transitions Phase 9 authority registration into controlled mutation of an isolated worktree.

## Goal

Apply only operations from an immutable, registered Web implementation pack, and only when every operation still matches the exact repository preimage that Web reviewed.

The application path has two explicit stages:

1. **whole-plan preflight** — read-only, deterministic, fail-closed;
2. **journaled mutation** — revalidates every preimage immediately before mutation, persists rollback material before each write, verifies exact postimages, and rolls back on failure.

No operation may write before the complete preflight succeeds.

## Current P10 implementation

`preflightWebOperations` verifies:

- the artifact registration still matches the pack authority;
- the worktree root is a real directory, not a symlink;
- every operation path is safe and cannot target `.git`;
- no two operations target the same path;
- target ancestors cannot be symlinks or non-directories;
- target files are regular non-symlink files when they exist;
- observed preimages are hashed through bounded, stable file-handle reads rather than unbounded `readFile()` calls;
- the opened file identity/size is checked against `lstat` before and after hashing, with `O_NOFOLLOW` where the platform exposes it;
- the observed SHA-256 preimage exactly matches the Web operation;
- create/replace/delete existence semantics are consistent;
- payload entries exist and match their bound SHA-256;
- preflight performs zero worktree mutation;
- identical state produces an identical plan digest.

`applyWebOperations` and `recoverWebOperationTransaction` add:

- an external WCO-owned transaction journal, independent of Codex thread/session persistence;
- a unique transaction directory per exact preflight plan, preventing blind replay of the same plan;
- whole-plan verification that every operation parent already exists as a real directory before mutation begins;
- immediate preimage revalidation before every individual operation;
- checksummed rollback backups persisted and synced before each replace/delete mutation;
- temporary-file + sync + rename writes for payloads and journal updates;
- exact postimage SHA-256 verification after each mutation;
- rollback in reverse operation order after an application failure;
- idempotent recovery of already rolled-back or committed journals;
- bounded streaming hash verification for worktree preimages and backup artifacts.

Directory creation is intentionally not implicit in this phase: a pack that targets a missing parent fails before mutation. This keeps the trust boundary simple until directory-operation semantics can be specified and tested separately.

## Performance, security, and usability rules

Operation application does not recursively rescan the repository and does not load Codex session history. File hashing is bounded and chunked so a hostile or accidentally huge worktree target cannot force an unbounded allocation. Backup verification and restoration are file-copy based rather than loading full backups into memory. Diagnostics identify the failing path/op while avoiding payload contents.

The journal/checkpoint path is deliberately WCO-owned. That shields operation recovery from upstream session/runtime failure modes rather than attempting to modify Codex internals. Current negative requirements include:

- do not depend on large Codex thread replay for operation application or recovery;
- persist WCO-owned authority, journals, and checkpoints independently of Codex session persistence;
- keep state/log growth bounded;
- expose explicit progress/checkpoint state instead of relying on a potentially blank or slow Codex resume UI;
- never treat an in-memory Codex session as authoritative over persisted WCO state;
- never infer recoverability merely from the existence of a displayed Codex session ID;
- keep mutation recovery valid even if Codex local indexing/session state is stale or missing.

These constraints are consistent with upstream reports observed in 2026: Codex resume can spend seconds scanning many rollout files; long-thread resume can remain blank while consuming CPU; session persistence errors can leave disk state divergent from in-memory state; and abrupt shutdowns have been reported to corrupt or regress local application state. WCO therefore uses explicit bounded state and atomic-ish temp/sync/rename persistence at its own boundary.

## Security boundary

Node's portable filesystem APIs cannot provide a universal multi-file atomic transaction or fully eliminate every path race on every host filesystem. P10 narrows that risk with safe relative paths, ancestor checks, stable file-handle hashing, `O_NOFOLLOW` when available, immediate preimage revalidation, same-directory temporary writes, durable rollback material, and postimage verification. Native `openat`-style directory-handle confinement is outside this TypeScript portability boundary and must not be falsely claimed.

## Tests

Phase 10 regression coverage includes deterministic mutation-free preflight, preimage drift rejection, symlink rejection, bounded-preimage rejection, successful journaled application, drift between preflight and apply, exact postimage verification, and idempotent crash recovery from checksummed rollback material.

## Remaining P10 gate

Before Phase 10 is frozen, exact-head CI must pass and the phase still needs a strict maintainer audit focused on transaction replay, partial-journal corruption, permission/mode behavior, Windows rename semantics, state-directory containment, and adversarial recovery races. Phase 10 does not merge PRs, mark PRs Ready, force-push, or alter OpenAI Codex CLI/app/agent internals.
=======
# Phase 10 — Code-First Constrained Executor

## Goal

Phase 10 consumes only a Phase 9 registered Web implementation pack and turns its exact operations into an auditable repository snapshot without giving a local agent architecture authority.

```text
REGISTERED_WEB_IMPLEMENTATION_PACK
        ↓
REVALIDATE_REGISTRY_AND_CANONICAL_RUN
        ↓
PREFLIGHT_LOCAL CODEX AUTH + SANDBOX
        ↓
VERIFY_ALL_PREIMAGES BEFORE FIRST WRITE
        ↓
PREPARE WRITE-AHEAD TRANSACTION
        ↓
APPLY EXACT WEB BYTES
        ↓
VERIFY POSTIMAGES / RECOVER CRASH
        ↓
DETERMINISTIC VERIFY
        ↓
TERRA READ-ONLY REVIEW
        ↓
SOL READ-ONLY REVIEW
        ↓
READY_FOR_PUBLISH
```

## Authority

1. Phase 9 registration + matching immutable archive are mandatory.
2. Canonical Phase 3 run/config and accepted Task Bundle remain higher authority than the registered pack.
3. Phase 10 independently revalidates registry/archive, run/repository/base/tree/spec and exact operation preimages before mutation.
4. `operations.json` is closed-world. A file absent from operations cannot be changed by Phase 10.
5. Exact Web payload bytes are applied by WCO deterministic code, not rewritten by Codex.
6. A stale base/preimage/spec/registry artifact results in `ESCALATE_TO_WEB` before any product write.
7. Local reviewers may reject the exact Web result; they may not redesign, edit, or silently expand the operation set.
8. Merge remains human-owned.

## Preflight order and user-facing failure behavior

Production execution checks cheap local authority first, then performs expensive runtime checks, while still ensuring all runtime checks happen before product mutation:

```text
CLI syntax / run identity
→ Phase 9 registration exists and matches
→ trusted config/run resolve
→ pinned Codex auth availability
→ Codex verifier sandbox smoke check
→ Phase 9 full fresh authority revalidation
→ transaction preparation / writes
```

This keeps missing-artifact/config errors fast and actionable, but prevents a run from partially modifying the worktree before discovering that Codex auth or the verifier sandbox is unavailable.

`wco-executor status` is deliberately read-only and does not start Codex, verification, GitHub access, or network work.

## Transaction model

All operations are validated before the first product-worktree mutation.

For each operation Phase 10 persists a transaction entry containing:

- operation ID/kind/path;
- exact preimage hash or null;
- exact postimage hash or null;
- backup hash/path for replace/delete;
- original file mode where applicable;
- applied state.

Backups are copied into WCO state and hash-verified before `PREPARED` is persisted. Creates have no backup. Executor receipt, backup and evidence files use bounded stable no-follow reads; executor state directories reject symbolic-link ancestors and realpath escape.

### Crash recovery

On restart during `APPLYING`, each registered target must be exactly one of:

- the registered preimage state;
- the registered postimage state.

The Git changed-path set may contain only registered operation paths. Any unrelated changed path is rejected before another product write. Anything neither preimage nor postimage is ambiguous external drift and becomes `ESCALATE_TO_WEB`.

If all observed targets are valid preimage/postimage states, WCO deterministically continues the same transaction. It never creates a different operation or rewrites the pack.

## Apply semantics

- `create_file`: target must be absent; write exact payload bytes.
- `replace_file`: target must equal preimage; save/verify backup; replace with exact payload bytes and preserve the original permission mode.
- `delete_file`: target must equal preimage; save/verify backup; delete exact target.

After every write, WCO reads the target through the bounded no-follow pattern and proves the exact expected postimage/absence.

## No implicit adaptation

Phase 10 v1 deliberately has **no free-form adaptation authority**. If exact Web code does not integrate, deterministic verification or Terra/Sol review returns a finding and WCO stops at `ESCALATE_TO_WEB`. A future registered pack/revision may explicitly authorize a different exact operation, but prose such as “fix imports if needed” is not implementation authority.

This is both safer and cheaper: there is **no implementer-model turn in Phase 10**. Web already authored the code, so local model usage is limited to independent read-only review rather than regenerating the same implementation.

## Verification and review

The resulting change-set digest is the snapshot identity for verification and reviews.

- validation commands come only from the accepted Task Bundle/trusted verifier contract;
- production verification runs through the pinned no-network Codex sandbox;
- verifier output is redacted and projected into bounded evidence;
- Terra and Sol use the configured reviewer profiles in read-only/no-network mode;
- review prompts contain the exact digest + registered changed paths and point to the accepted Task Bundle instead of replaying the implementation transcript;
- model usage counters exposed by the runtime are preserved in bounded reviewer evidence for later performance/token telemetry;
- any mutation invalidates prior verification and reviews;
- both review stages must APPROVE the same digest before `READY_FOR_PUBLISH`;
- a later READY retry re-attests the exact digest rather than trusting stale success.

If verification/review identifies a correction, Phase 10 does not edit outside the pack. It emits bounded evidence suitable for a new Web pack and stops at `ESCALATE_TO_WEB`.

## Performance / security / UX design notes

Phase 10 follows `PERFORMANCE.md` and the project threat model:

- deterministic byte application replaces a redundant local implementation turn;
- context is progressively disclosed: digest/path list + accepted task repository context, not full prior chat history;
- reviewer prompt assembly has a hard byte cap;
- persisted diagnostics/evidence/backups/receipts have hard size bounds;
- every child runtime used by the reused verifier has timeout/cancellation/output bounds;
- runtime and sandbox preflight happen once per manual executor invocation; Phase 11 may introduce a bounded health-cache TTL, but health cache never becomes authority;
- missing registration and status paths avoid Codex startup entirely;
- normal user UX will move to durable orchestration/native commands in Phases 11–12; `wco-executor` remains an explicit operations/debug surface.

These choices align with least-privilege agent guidance: model reviewers get read-only tools, no network, no write authority, and no irreversible Git/GitHub capability. Authorization comes from deterministic code and registered artifacts, never from model output alone.

## Operator commands

```bash
wco-executor execute \
  --run-id <task-id>:<task-bundle-sha256> \
  --artifact-sha256 <registered-web-pack-sha256> \
  --state-dir <state-dir> \
  --config <trusted-config> \
  --json

wco-executor status \
  --run-id <task-id>:<task-bundle-sha256> \
  --artifact-sha256 <registered-web-pack-sha256> \
  --state-dir <state-dir> \
  --json
```

These commands are not the intended final daily workflow; they exist for explicit operations, testing and recovery while Phase 11 builds the durable control plane.

## Forbidden capabilities

Phase 10 must not:

- modify `.git/**`;
- modify unregistered paths;
- execute archive payload files as programs;
- accept a loose patch/chat instruction as authority;
- give reviewers workspace-write or network access;
- amend/rebase/commit/push;
- create/update/mark-ready/merge a PR;
- weaken validation or acceptance criteria;
- change architecture/spec locks;
- reset/revert unrelated worktree state.

## Exit criteria

- exact registered-pack consumer revalidation;
- auth/sandbox preflight before mutation;
- all-preimages-before-write guarantee;
- write-ahead transaction + crash recovery;
- exact postimage verification;
- closed-world changed-path guard on normal execution and resume;
- deterministic verifier integration;
- Terra/Sol read-only review bound to exact digest;
- failure evidence routes back to Web without local redesign;
- compiled CLI/status path;
- bounded/no-follow receipt, backup and evidence state;
- adversarial tests for symlink/path/race/partial-apply/recovery/unregistered mutation/stale terminal approval;
- exact stacked-head release gate and independent maintainer audit.
