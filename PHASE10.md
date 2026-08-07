# Phase 10 — Code-First Constrained Executor

## Goal

Phase 10 consumes only a Phase 9 registered Web implementation pack and turns its exact operations into an auditable repository snapshot without giving a local agent architecture authority.

```text
REGISTERED_WEB_IMPLEMENTATION_PACK
        ↓
REVALIDATE_REGISTRY_AND_CANONICAL_RUN
        ↓
VERIFY_ALL_PREIMAGES_BEFORE_FIRST_WRITE
        ↓
PREPARE_WRITE_AHEAD_TRANSACTION
        ↓
APPLY_EXACT_WEB_BYTES
        ↓
VERIFY_POSTIMAGES / RECOVER_CRASH
        ↓
DETERMINISTIC_VERIFY
        ↓
TERRA_REVIEW
        ↓
SOL_REVIEW
        ↓
READY_FOR_PUBLISH
```

## Authority

1. Phase 9 registration + matching immutable archive are mandatory.
2. Canonical Phase 3 run/config and accepted Task Bundle remain higher authority than the registered pack.
3. Phase 10 must independently revalidate the registry/archive, run/repository/base/tree/spec and exact operation preimages before mutation.
4. `operations.json` is closed-world. A file absent from operations cannot be changed by Phase 10.
5. Exact Web payload bytes are applied by WCO deterministic code, not rewritten by Codex.
6. A stale base/preimage/spec/registry artifact results in `ESCALATE_TO_WEB` before any write.
7. Local agent review may reject the exact Web result; it may not redesign or silently expand the operation set.
8. Merge remains human-owned.

## Transaction model

All operations are validated before the first product-worktree mutation.

For each operation Phase 10 persists a transaction entry containing:

- operation ID/kind/path;
- exact preimage hash or null;
- exact postimage hash or null;
- backup hash/path for replace/delete;
- applied state.

Backups are copied into WCO state and hash-verified before `APPLYING` is persisted. Creates have no backup. Product paths are walked component-by-component and symlink/non-directory ancestors fail closed.

### Crash recovery

On restart during `APPLYING`, each target must be exactly one of:

- the registered preimage state;
- the registered postimage state.

Anything else is ambiguous external drift and becomes `ESCALATE_TO_WEB`.

If all observed targets are preimage/postimage states, WCO deterministically continues the same transaction. It must never create a different operation or rewrite the pack.

## Apply semantics

- `create_file`: target must be absent; write exact payload bytes.
- `replace_file`: target must equal preimage; save/verify backup; replace with exact payload bytes.
- `delete_file`: target must equal preimage; save/verify backup; delete exact target.

After every write, WCO reads the target through the bounded no-follow pattern and proves the exact expected postimage/absence.

## No implicit adaptation

Phase 10 v1 deliberately has **no free-form adaptation authority**. If exact Web code does not integrate, deterministic verification or Terra/Sol review returns a finding and WCO stops at `ESCALATE_TO_WEB`. A future registered pack/revision may explicitly authorize a bounded adaptation operation, but prose such as “fix imports if needed” is not enough.

This is stricter than allowing an executor to reinterpret Web intent, and is intentionally cheaper in tokens: model turns review the result instead of regenerating code Web already authored.

## Verification and review

The resulting change-set digest is the snapshot identity for verification and reviews.

- validation commands come only from the accepted Task Bundle/trusted verifier contract;
- verifier output is bounded/redacted;
- Terra and Sol review the exact resulting digest;
- any mutation invalidates prior verification and reviews;
- both review stages must APPROVE the same digest before `READY_FOR_PUBLISH`.

If verification/review identifies a correction, Phase 10 does not edit outside the pack. It emits bounded evidence suitable for a new Web pack and stops at `ESCALATE_TO_WEB`.

## Forbidden capabilities

Phase 10 must not:

- modify `.git/**`;
- modify unregistered paths;
- execute archive payload files as programs;
- accept a loose patch/chat instruction as authority;
- amend/rebase/commit/push;
- create/update/mark-ready/merge a PR;
- weaken validation or acceptance criteria;
- change architecture/spec locks;
- reset/revert unrelated worktree state.

## Exit criteria

- exact registered-pack consumer revalidation;
- all-preimages-before-write guarantee;
- write-ahead transaction + crash recovery;
- exact postimage verification;
- closed-world changed-path guard;
- deterministic verifier integration;
- Terra/Sol review bound to exact digest;
- failure evidence routes back to Web without local redesign;
- compiled CLI/status path;
- adversarial tests for symlink/path/race/partial-apply/recovery/unregistered mutation;
- exact stacked-head release gate and independent maintainer audit.
