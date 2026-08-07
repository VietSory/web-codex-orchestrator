# Phase 8 Coverage — Same-PR Revision Loop

This document maps the Phase 8 contract in `PHASE8.md` to production boundaries and executable tests. Phase 8 is merge-ready only when the exact PR head passes `npm run phase8:release-gate` and the pull request remains open, Draft, and unmerged. A documentation claim without a named production boundary and executable test is not treated as proof.

## Release gate

```bash
npm run phase8:release-gate
```

The gate runs, in order:

1. TypeScript typecheck.
2. Unit and fake-integration suite, including all `P8-MAINT-*` adversarial tests.
3. Dedicated Phase 8 end-to-end loop.
4. Production build.
5. Compiled CLI integration tests for Phases 6, 7, and 8.

CI executes the Phase 8 end-to-end test as a separate bounded step so a stuck integration boundary cannot hide inside the unit suite.

## Authority and handoff

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Only a sealed Phase 7 `REVISION_REQUESTED` handoff may start a revision | `src/revision/revision-source.ts` | `P8-FND-006` and Phase 7 terminal-state tests |
| Revision request is validated with the exact schema embedded in the previous verified Result Bundle | `revision-source.ts`, `result-bundle-review-reader.ts` | `P8-FND-006`, Result Bundle/embedded-schema Phase 7 tests |
| Request/verdict/result/spec/commit/head/PR bindings are exact | `revision-source.ts` | `P8-FND-006`, `P8-E2E-001` |
| Accepted Task Bundle must still equal the tree sealed in the previous verified Result Bundle before any revision work | `revision-authority.ts`, `revision-service.ts` | `P8-MAINT-002` |
| Recomputing `checksums.json` after Task Bundle mutation cannot create new authority | `revision-authority.ts` | `P8-MAINT-002` |
| Mutable revision checkpoints cannot redefine canonical run/history/worktree/PR/model authority on resume | `revision-authority.ts`, `revision-service.ts` | `P8-MAINT-003` |
| Web review round 1 accepts only initial Result Bundle v1.1; rounds 2..4 accept only revision Result Bundle v1.2 for revision round 1..3 | `result-bundle-review-reader.ts` | `P8-MAINT-004`, `P8-E2E-001` |
| Missing revision bundle never falls back to an older bundle | `result-bundle-review-reader.ts` | `P8-FND-001`, `P7-REM-005`, `P7-REM-006` |
| Phase 7 verifies the v1.2 bundle's previous bundle/receipt/verdict/request/commit/head/spec/PR chain against the exact previous terminal round | `review-history.ts` | `P8-MAINT-005`, `P8-E2E-001` |
| Maximum revision count is three | contracts, paths, CLI, service | `P8-RB-002`, state-contract and CLI integration tests |

## State, path, lock, and recovery

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Revision state is confined under the registered state root | `revision-paths.ts` | `P8-FND-002` plus revision path tests |
| Symlink ancestors and unsafe state paths fail closed | `revision-paths.ts`, `revision-store.ts` | `P8-FND-002` |
| One revision round has one exclusive lock | `revision-lock.ts` | `P8-FND-003` |
| Stale/malformed locks are not silently stolen | `revision-lock.ts` | `P8-FND-003` |
| Persisted receipt state/usage is bounded and validated | `revision-store.ts`, `contracts.ts` | `P8-STATE-001..003` |
| `RETRYABLE` carries one explicit `resume_state`; non-retryable states cannot hide one | `contracts.ts`, `revision-store.ts`, `revision-service.ts` | `P8-STATE-001`, `P8-STATE-002` |
| Budget counters are persisted before agent/reviewer calls so retries do not refund reserved turns | `revision-service.ts`, `execution/budget.ts` | Phase 4 persisted-budget regression plus Phase 8 state validation |
| A completed revision Result Bundle can be independently reverified and adopted when the parent revision checkpoint lags behind | `revision-result-bundle.ts` | `P8-MAINT-006` |
| Archive-visible Phase 8 creation time is stable across retry; deterministic ZIP builder compare-and-adopt remains valid after mid-build crashes | `revision-result-bundle.ts`, `deterministic-zip.ts` | `P8-MAINT-006` plus deterministic ZIP compare-and-adopt tests |

## Revision execution and review

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Revision reuses the canonical isolated worktree and existing branch | `revision-service.ts`, `revision-authority.ts`, `revision-git.ts` | `P8-E2E-001`, `P8-MAINT-003` |
| Frozen accepted bundle is historically re-attested before work and snapshotted for no-change checks before publication | `revision-authority.ts`, `revision-service.ts` | `P8-MAINT-002`, `P8-E2E-001` |
| Path/change limits remain bounded by the frozen task contract and trusted config | `revision-service.ts`, `execution/path-policy.ts` | shared Phase 4 path-policy tests; Phase 8 invokes the same boundary before verifier/review/publication |
| Deterministic verifier runs before independent review | `revision-service.ts`, `verifier.ts` | `P8-E2E-001` plus verifier regressions |
| Terra and Sol review exact change-set digests independently | `revision-service.ts` | `P8-E2E-001`, structured-output tests |
| Any correction clears previous verifier/Terra/Sol approval fields before returning to the verification loop | `revision-service.ts` | code-level state transition plus inherited Phase 4 correction-loop regressions; final publication equality is exercised by `P8-E2E-001` |
| Publication requires verifier + Terra + Sol to bind the same final digest and approved file snapshot | `revision-service.ts`, `revision-git.ts` | `P8-E2E-001`, `P8-GIT-003` |

## Same-PR Git publication

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Initial local HEAD, branch, configured remote identity, and remote branch equal the sealed previous head | `revision-git.ts` | `P8-GIT-001`, `P8-GIT-002`, `P8-E2E-001` |
| The remote URL is rechecked before every network `ls-remote`/push so a post-checkpoint remote replacement cannot receive credentials or publication | `revision-git.ts` | `P8-MAINT-001` |
| Approved working bytes are re-hashed before staging | `revision-git.ts` | `P8-GIT-003` |
| Staged index must equal the approved snapshot | `revision-git.ts` | `P8-GIT-001`, mutation regressions |
| Revision commit has exactly one parent: previous PR head | `revision-git.ts` | `P8-GIT-001`, `P8-E2E-001` |
| Commit path set and commit tree equal the approved revision snapshot | `revision-git.ts` | `P8-GIT-001`, `P8-GIT-003` |
| Remote branch drift blocks revision publication | `revision-git.ts` | `P8-GIT-002` |
| Mutation after approval blocks before staging | `revision-git.ts` | `P8-GIT-003` |
| Publisher never emits force, force-with-lease, amend, rebase, or branch-deletion push | `revision-git.ts` | `P8-GIT-004` |
| `COMMITTED` checkpoint is persisted after exact commit verification and before push | `revision-git.ts`, `revision-service.ts` | `P8-PUB-001` |
| Crash after commit adopts the exact existing commit instead of making a second commit | `revision-git.ts` | `P8-GIT-REC-001` |
| A failing fresh pre-push authority check occurs after the local commit but before any remote movement | `revision-git.ts` | `P8-MAINT-007` |
| Normal push must re-attest the exact new remote head | `revision-git.ts` | `P8-GIT-001`, `P8-E2E-001` |

## GitHub Draft PR boundary

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Revision starts only on the original open, unmerged Draft PR | `revision-github-attestation.ts`, `revision-service.ts` | `P8-FND-005`, `P8-E2E-001` |
| Immediately before an actual push, the same PR is freshly required to remain open, unmerged, Draft and at the exact previous head/base | `revision-service.ts`, `revision-github-attestation.ts`, `revision-git.ts` | `P8-MAINT-007`, `P8-E2E-001` |
| PR marked Ready, closed, merged, wrong repo, wrong branch, wrong head, or wrong base fails closed | `revision-github-attestation.ts` | `P8-FND-005` plus inherited Phase 7 GitHub attestation/taxonomy regressions |
| Phase 8 never creates another PR, marks ready, or merges | CLI/service/Git command surface | `P8-GIT-004`, compiled Phase 8 CLI integration, final source audit |
| After push the same PR is freshly attested at the exact new head | `revision-service.ts`, `revision-github-attestation.ts` | `P8-E2E-001` |

## Revision Result Bundle v1.2

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Revision bundles use `result_bundle_version: 1.2`, `input_kind: revision`, and bounded revision round | `revision-result-bundle.ts`, `result-bundle-store.ts` | `P8-RB-001`, `P8-RB-002`, `P8-E2E-001` |
| Receipt chain fields are mandatory and Phase 7 checks them against the exact previous terminal round | `result-bundle-store.ts`, `review-history.ts` | `P8-RB-001`, `P8-MAINT-005`, `P8-E2E-001` |
| `repository/*` is cumulative original-base -> current-head evidence | `revision-result-bundle.ts` | `P8-E2E-001` |
| `revision/*` is previous-head -> current-head delta evidence | `revision-result-bundle.ts` | `P8-E2E-001` |
| Frozen task and Web review contract/schema bytes are copied from the previous verified bundle | `revision-result-bundle.ts` | `P8-E2E-001` plus Phase 7 embedded-contract verification |
| Existing ready archive is independently verified before recovery adoption | `revision-result-bundle.ts` | `P8-MAINT-006` |
| Phase 6 v1.1 Result Bundle receipts remain backward-compatible only for the initial review role | `result-bundle-store.ts`, `result-bundle-review-reader.ts` | `P8-RB-003`, `P8-MAINT-004` |

## Full-loop proof

`tests/integration/phase8-e2e.integration.ts` loads `tests/phase8-e2e-support.ts` and exercises a complete local-only flow with a real Git repository and a real bare remote. The fake GitHub client derives PR head identity from the remote branch, not unpushed local `HEAD`, so the pre-push and post-push attestations model the actual GitHub visibility boundary.

```text
initial product commit
-> Phase 6 Result Bundle v1.1
-> Phase 7 REVISE
-> sealed revision-request.json
-> Phase 8 Task Bundle / worktree / remote / Draft PR re-attestation
-> bounded implementation
-> deterministic verification
-> Terra APPROVE
-> Sol APPROVE
-> exactly one same-branch commit
-> fresh pre-push Draft/previous-head authority check
-> normal push to same remote branch
-> fresh post-push same Draft PR/new-head attestation
-> revision Result Bundle v1.2
-> Web review round 2 with exact history-chain verification
-> APPROVED / ASK_USER_TO_MERGE
```

The fake model/sandbox components remove external model nondeterminism; Git, the bare remote, state, bundle construction/verification, Phase 7 verdict processing, Phase 8 orchestration, and revision publication remain production code paths.

## Final maintainer checklist

Before merging Phase 8, verify the exact PR head:

- [ ] PR is still open, Draft, mergeable, and unmerged.
- [ ] Base is the merged Phase 7 `main` snapshot and PR head is not behind it.
- [ ] `npm run phase8:release-gate` is green on the exact head.
- [ ] Dedicated Phase 8 end-to-end step is green.
- [ ] All `P8-MAINT-*` adversarial tests are green.
- [ ] Compiled Phase 8 CLI integration is green.
- [ ] No production revision code contains a force-push, amend, rebase, branch-delete, PR-create, mark-ready, or merge path.
- [ ] No Web-review round fallback exists.
- [ ] Review-round bundle role and v1.2 previous-history chain are explicitly enforced, not inferred only from paths.
- [ ] Accepted Task Bundle tree is re-attested against previously sealed authority before revision work.
- [ ] Remote URL is re-attested before network Git operations and fresh Draft PR authority is checked immediately before a real push.
- [ ] Crash-after-commit recovery creates no second commit and ready revision Result Bundle recovery preserves exact archive bytes.
- [ ] README, CHANGELOG, SECURITY, PHASE8 and this coverage map describe the same implemented workflow.
- [ ] The user remains the only actor who decides whether to merge.
