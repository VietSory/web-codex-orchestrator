# Phase 8 Coverage — Same-PR Revision Loop

This document maps the Phase 8 contract in `PHASE8.md` to production boundaries and executable tests. Phase 8 is merge-ready only when the exact PR head passes `npm run phase8:release-gate` and the pull request remains open, Draft, and unmerged.

## Release gate

```bash
npm run phase8:release-gate
```

The gate runs, in order:

1. TypeScript typecheck.
2. Unit and fake-integration suite.
3. Dedicated Phase 8 end-to-end loop.
4. Production build.
5. Compiled CLI integration tests for Phases 6, 7, and 8.

CI executes the Phase 8 end-to-end test as a separate bounded step so a stuck integration boundary cannot hide inside the unit suite.

## Authority and handoff

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Only a sealed Phase 7 `REVISION_REQUESTED` handoff may start a revision | `src/revision/revision-source.ts` | `tests/phase8-foundation.test.ts` |
| Revision request is validated with the exact schema embedded in the previous verified Result Bundle | `revision-source.ts`, `result-bundle-review-reader.ts` | `phase8-foundation.test.ts`, `phase8-result-receipt.test.ts` |
| Request/verdict/result/spec/commit/head/PR bindings are exact | `revision-source.ts` | `phase8-foundation.test.ts`, dedicated E2E |
| Web review round 1 reads the initial Result Bundle; later rounds read the exact preceding revision bundle | `src/web-review/result-bundle-review-reader.ts` | `phase7-remediation.test.ts`, dedicated E2E |
| Missing revision bundle never falls back to an older bundle | `result-bundle-review-reader.ts` | `phase8-foundation.test.ts`, `phase7-remediation.test.ts` |
| Maximum revision count is three | contracts, paths, CLI, service | `phase8-result-receipt.test.ts`, `phase8-state-contract.test.ts`, CLI integration |

## State, path, lock, and recovery

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Revision state is confined under the registered state root | `revision-paths.ts` | `phase8-foundation.test.ts` |
| Symlink ancestors and unsafe state paths fail closed | `revision-paths.ts`, `revision-store.ts` | `phase8-foundation.test.ts` |
| One revision round has one exclusive lock | `revision-lock.ts` | `phase8-foundation.test.ts` |
| Stale/malformed locks are not silently stolen | `revision-lock.ts` | `phase8-foundation.test.ts` |
| Persisted receipt fields, review evidence, usage counters, and timestamps are bounded and validated | `revision-store.ts` | `phase8-state-contract.test.ts` |
| `RETRYABLE` carries one explicit `resume_state`; non-retryable states cannot hide one | `contracts.ts`, `revision-store.ts`, `revision-service.ts` | `phase8-state-contract.test.ts` |
| Agent/reviewer usage counters survive restart and cannot be reset by a retry | `revision-service.ts`, `execution/budget.ts` | `phase8-state-contract.test.ts` plus service persistence checks |
| Terminal `BLOCKED`/`FAILED` rounds do not auto-resume | `revision-service.ts` | service state-machine coverage and final E2E/release gate |

## Revision execution and review

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Revision reuses the existing isolated worktree and branch | `revision-service.ts`, `revision-git.ts` | dedicated E2E |
| Frozen accepted bundle is snapshotted before work and checked again before publication | `revision-service.ts` | foundation/service coverage and E2E |
| Path/change limits remain bounded by the frozen task contract and trusted config | `revision-service.ts`, `execution/path-policy.ts` | existing Phase 4 policy tests plus Phase 8 service gate |
| Deterministic verifier runs before independent review | `revision-service.ts`, `verifier.ts` | dedicated E2E and existing verifier tests |
| Terra and Sol review exact change-set digests independently | `revision-service.ts` | dedicated E2E and structured-output tests |
| Any correction invalidates previous verification/review approval | `revision-service.ts` | state-machine/release-gate coverage |
| Publication requires verifier + Terra + Sol to bind the same final digest | `revision-service.ts` | dedicated E2E |

## Same-PR Git publication

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Local HEAD, branch, remote identity, and remote branch equal the sealed previous head before revision | `revision-git.ts` | `phase8-revision-git.test.ts`, E2E |
| Approved working bytes are re-hashed before staging | `revision-git.ts` | `phase8-revision-git.test.ts` |
| Staged index must equal the approved snapshot | `revision-git.ts` | `phase8-revision-git.test.ts` |
| Revision commit has exactly one parent: previous PR head | `revision-git.ts` | `P8-GIT-001`, E2E |
| Commit path set and commit tree equal the approved revision snapshot | `revision-git.ts` | `phase8-revision-git.test.ts` |
| Remote drift blocks before commit/push | `revision-git.ts` | `P8-GIT-002` |
| Mutation after approval blocks before staging | `revision-git.ts` | `P8-GIT-003` |
| Publisher never emits force, force-with-lease, amend, rebase, or branch-deletion push | `revision-git.ts` | `P8-GIT-004` |
| `COMMITTED` checkpoint is persisted after exact commit verification and before push | `revision-git.ts`, `revision-service.ts` | `phase8-publish-checkpoint.test.ts` |
| Crash after commit adopts the exact existing commit instead of making a second commit | `revision-git.ts` | `phase8-revision-git-recovery.test.ts` |
| Normal push must re-attest the exact new remote head | `revision-git.ts` | Git tests and E2E |

## GitHub Draft PR boundary

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Revision operates only on the original open Draft PR | `revision-github-attestation.ts` | `phase8-foundation.test.ts`, E2E |
| PR marked ready, closed, merged, wrong repo, wrong branch, wrong head, or wrong base fails closed | `revision-github-attestation.ts` | foundation/adversarial tests and inherited Phase 7 GitHub taxonomy tests |
| Phase 8 never creates another PR, marks ready, or merges | architecture + command surface | static final audit, `P8-GIT-004`, compiled CLI coverage |
| After push the same PR is freshly attested at the exact new head | `revision-service.ts`, `revision-github-attestation.ts` | dedicated E2E |

## Revision Result Bundle v1.2

| Invariant | Production boundary | Coverage |
| --- | --- | --- |
| Revision bundles use `result_bundle_version: 1.2`, `input_kind: revision`, and bounded revision round | `revision-result-bundle.ts`, `result-bundle-store.ts` | `phase8-result-receipt.test.ts`, E2E |
| Chain binds previous bundle receipt/verdict/commit/head and sealed request/evidence | same | `phase8-result-receipt.test.ts`, E2E |
| `repository/*` is cumulative original-base → current-head evidence | `revision-result-bundle.ts` | E2E |
| `revision/*` is previous-head → current-head delta evidence | `revision-result-bundle.ts` | E2E |
| Frozen task and Web review contract/schema bytes are copied from the previous verified bundle | `revision-result-bundle.ts` | E2E + Phase 7 bundle-reader validation |
| Existing deterministic archive may be adopted only when exact bytes/hash match | `deterministic-zip.ts` | existing Phase 6 deterministic archive tests, exercised by Phase 8 packaging |
| Phase 6 v1.1 Result Bundle receipts remain backward-compatible | `result-bundle-store.ts` | `phase8-result-receipt.test.ts`, existing Phase 6 store tests |

## Full-loop proof

`tests/integration/phase8-e2e.integration.ts` loads `tests/phase8-e2e-support.ts` and exercises a complete local-only flow with a real Git repository and a real bare remote:

```text
initial product commit
→ Phase 6 Result Bundle
→ Phase 7 REVISE
→ sealed revision-request.json
→ Phase 8 bounded implementation
→ deterministic verification
→ Terra APPROVE
→ Sol APPROVE
→ exactly one same-branch commit
→ normal push to same remote branch
→ fresh same Draft PR attestation
→ revision Result Bundle v1.2
→ Web review round 2
→ APPROVED / ASK_USER_TO_MERGE
```

The fake model/sandbox components remove external model/network nondeterminism; Git, state, bundle construction/verification, Phase 7 verdict processing, Phase 8 orchestration, and revision publication remain production code paths.

## Final maintainer checklist

Before merging Phase 8, verify the exact PR head:

- [ ] PR is still open, Draft, and unmerged.
- [ ] Base is the merged Phase 7 `main` snapshot.
- [ ] `npm run phase8:release-gate` is green on the exact head.
- [ ] Dedicated Phase 8 end-to-end step is green.
- [ ] Compiled Phase 8 CLI integration is green.
- [ ] No production revision code contains a force-push, amend, rebase, branch-delete, PR-create, mark-ready, or merge path.
- [ ] No Web-review round fallback exists.
- [ ] Result Bundle v1.2 chain fields are mandatory and v1.1 remains accepted for the initial bundle.
- [ ] Crash-after-commit recovery creates no second commit.
- [ ] The user remains the only actor who decides whether to merge.
