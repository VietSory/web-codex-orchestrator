# Phase 5A — Verified Git commit and branch push

Phase 5A introduces a fail-closed Git publication primitive. It consumes an
attested Phase 4 change-set digest and exact path list, creates one commit on
the already prepared delivery branch, pushes that exact commit without force,
and verifies the remote branch SHA.

## Included in this increment

- exact Phase 4 digest and path-set revalidation through an injected trusted inspector;
- canonical worktree, base commit, current branch, remote URL, and branch-policy checks;
- exact path staging with `--literal-pathspecs`;
- staged path-set equality check before commit;
- one non-amended, non-GPG product commit;
- one non-force branch push;
- remote SHA verification after push;
- atomic publish receipts with `READY_FOR_COMMIT`, `COMMITTED`, and `PUSHED` states;
- idempotent recovery from both `COMMITTED` and `PUSHED` receipts;
- local bare-remote integration coverage.

## Deliberately excluded

- CLI wiring;
- reading Phase 4 receipts directly;
- GitHub API calls;
- Draft pull-request creation;
- browser automation;
- merge, force-push, branch deletion, release, or deployment;
- any modification to Phase 4 state-machine or review behavior.

The next increment must adapt the existing Phase 4 `calculateChangeSet()` and
`GitRunner` into this primitive. The primitive intentionally requires those
trusted dependencies to be injected rather than duplicating the established
Phase 3/4 security boundaries.
