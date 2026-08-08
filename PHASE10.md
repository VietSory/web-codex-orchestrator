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
