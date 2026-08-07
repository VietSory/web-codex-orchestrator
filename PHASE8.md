# Phase 8 — Same-PR Revision Loop

## Role

Phase 8 consumes only a sealed Phase 7 `revision-request.json` and turns that request into a verified fast-forward revision of the existing Draft Pull Request.

The normal transition is:

```text
Phase 7 REVISION_REQUESTED
→ attest exact previous Result Bundle / verdict / revision request / PR head
→ revise existing isolated worktree
→ path-policy + deterministic verification
→ Terra review
→ Sol review
→ append one normal commit to the existing PR branch
→ normal fast-forward push to the same remote branch
→ fresh Draft PR attestation
→ deterministic revision Result Bundle
→ Phase 7 review round N+1
```

Phase 8 never creates a replacement PR and never changes the frozen task specification.

## Frozen inputs

A revision round is authorized only by the previous Phase 7 terminal receipt in state `REVISION_REQUESTED` and its exact canonical artifacts.

The sealed `revision-request.json` binds:

- `run_id`;
- revision round `1..3`;
- frozen `spec_set_sha256`;
- previous Result Bundle SHA-256;
- previous Web verdict SHA-256;
- previous published commit SHA;
- previous PR head SHA;
- Pull Request number;
- the complete fixable finding set.

No loose prompt, patch, local note, chat message, alternate JSON file, or unregistered artifact may override this request.

## Hard invariants

1. `run_id` remains the original Task Bundle identity. Phase 8 does not create a new task identity.
2. The accepted Task Bundle is immutable and its checksum/spec lock must still verify before every revision execution.
3. The original Phase 3 isolated worktree is reused only if it is a canonical directory below the configured state root, is clean, is on the original delivery branch, and `HEAD` equals `previous_pr_head_sha`.
4. The existing GitHub Pull Request must remain open, unmerged and Draft. PR number, repository, head branch and base branch must match the frozen delivery contract.
5. Before implementation, local HEAD, remote branch HEAD, GitHub PR head and `previous_pr_head_sha` must all be identical.
6. Agents may modify only the original execution contract's allowed paths. Original forbidden paths, file/count/diff limits, no-symlink/no-special-file/no-submodule/no-binary rules and verifier sandbox policy remain authoritative.
7. The revision implementer may fix only the sealed Phase 7 findings and verifier/reviewer regressions caused by that revision. It may not redesign, expand requirements, weaken tests, change the frozen acceptance set, change delivery policy, commit, push or use network access.
8. Deterministic verification must pass on the exact revision delta before any reviewer starts.
9. Terra and Sol independently review the exact same revision change-set digest. Both must return `APPROVE` before publication.
10. If verification or a reviewer returns fixable findings, the same implementer thread may perform bounded correction under the trusted Phase 4 agent limits. A new correction invalidates prior verification and reviews.
11. The published revision is exactly one normal Git commit whose parent is `previous_pr_head_sha`. Phase 8 must never amend, rebase, force-push, delete a remote branch or merge.
12. The remote update is a normal fast-forward push. Immediately before the push, the remote branch must still equal `previous_pr_head_sha`; after the push it must equal the new commit SHA.
13. The same Draft PR number must attest the new commit as its exact head after publication.
14. Revision rounds are append-only. Round 1, 2 and 3 have separate immutable state directories and receipts. A completed round is idempotent only when all exact hashes and Git/PR bindings still match.
15. The revision Result Bundle keeps the original frozen spec set, contains the cumulative current implementation evidence and the exact revision delta, and binds the previous Result Bundle/verdict/revision-request/published-head chain.
16. Phase 8 performs no merge, no Mark Ready, no PR close/reopen, no PR replacement and no specification mutation.

## State layout

```text
revisions/runs/<task-id>/<task-bundle-sha>/rounds/<01..03>/
├── revision-request.json
├── revision-receipt.json
├── implementation.json
├── verification.json
├── terra-review.json
├── sol-review.json
├── publish.json
└── revision.lock
```

Revision Result Bundles are stored separately from the immutable initial Phase 6 bundle:

```text
handoff/runs/<task-id>/<task-bundle-sha>/revisions/<01..03>/
├── result-bundle.json
└── wco-result-<task-id>-<new-head-sha12>.zip
```

The initial Phase 6 `handoff/runs/.../result-bundle.json` and archive are never overwritten.

## State machine

```text
READY_TO_REVISE
→ IMPLEMENTING
→ POLICY_CHECKING
→ VERIFYING
→ TERRA_REVIEWING
→ SOL_REVIEWING
→ READY_FOR_PUBLISH
→ COMMITTED
→ PUSHED
→ RESULT_READY
```

Failure terminals:

```text
BLOCKED
RETRYABLE
FAILED
```

Any implementation correction returns to `POLICY_CHECKING` and invalidates verification/Terra/Sol evidence.

## Result Bundle review rounds

Phase 7 review round mapping is deterministic:

- initial Phase 6 Result Bundle → Web review round 1;
- Phase 8 revision round 1 → Web review round 2;
- Phase 8 revision round 2 → Web review round 3;
- Phase 8 revision round 3 → Web review round 4.

Phase 7 must select the Result Bundle corresponding to the incoming `review_round`; it must never silently fall back to the initial bundle for a revision review.

## CLI

Normal Phase 8 execution:

```bash
wco revise \
  --run-id <task-id:task-bundle-sha256> \
  --state-dir <directory> \
  --config <config.json> \
  --round <1-3> \
  [--json]
```

Read-only status:

```bash
wco revision-status \
  --run-id <task-id:task-bundle-sha256> \
  --state-dir <directory> \
  [--round <1-3>] \
  [--json]
```

## Non-goals

Phase 8 does not introduce Mission Mode, persistent project memory, Web Authority implementation packs, native Codex integration, automatic merge or multi-PR orchestration. Those remain later phases.

Phase 8 is complete when a sealed Phase 7 `REVISE` request can be processed end-to-end into a new verified Result Bundle on the same Draft PR, with crash-safe/idempotent receipts and no human orchestration between revision request and the next Web review handoff.
