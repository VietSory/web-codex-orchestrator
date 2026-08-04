# Phase 5A — verified Git commit and push boundary

Phase 5A consumes a completed Phase 4 execution receipt and publishes exactly
that approved change set as one Git commit on the prepared delivery branch.
It then pushes that commit to the one trusted remote without force-push.

## Production flow

```text
READY_FOR_PUBLISH execution receipt
  → re-read accepted delivery and Git policy
  → verify bundle checksums
  → recompute the Phase 4 change-set digest
  → persist READY_FOR_COMMIT publish intent
  → stage only the approved path set
  → compare the staged index snapshot with the pre-stage snapshot
  → create one commit whose only parent is the approved base commit
  → compare the commit tree snapshot with the pre-stage snapshot
  → persist COMMITTED
  → push commit SHA to the exact approved branch ref
  → verify the remote branch SHA
  → persist PUSHED
```

The production entry point is:

```bash
npm run build
node dist/cli/index.js publish \
  --run-id '<task-id>:<archive-sha256>' \
  --state-dir '<absolute-state-directory>' \
  --config '<phase4-config.json>'
```

During development the TypeScript CLI may be used:

```bash
npx tsx src/cli/index.ts publish \
  --run-id '<task-id>:<archive-sha256>' \
  --state-dir '<absolute-state-directory>' \
  --config '<phase4-config.json>'
```

## Crash recovery

A durable `READY_FOR_COMMIT` receipt is written before staging. It includes the
approved content snapshot. If a process stops after staging but before commit, a
later invocation may continue only when the complete staged path set and staged
index snapshot exactly match that durable approved snapshot. If Git creates the commit and the process stops
before `COMMITTED` is persisted, a later invocation may adopt the existing HEAD
only when all of these are true:

- it has exactly one parent;
- that parent is the approved base commit;
- the changed path set exactly matches the approved path set;
- the commit message matches the deterministic approved message;
- the commit tree snapshot matches the durable pre-commit snapshot.

A process stop after push but before `PUSHED` persistence is also recoverable.
The remote is never pushed again when it already points to the approved commit.

## Security invariants

- Phase 4 must be `READY_FOR_PUBLISH`.
- Verifier, Terra reviewer, and Sol reviewer must approve the same digest.
- The accepted bundle and delivery contract are re-read before publication.
- The first attempt starts at the exact base commit.
- No direct push to `main` or another denied branch.
- No force-push.
- No remote branch deletion.
- No merge.
- No GitHub API or Draft PR creation in Phase 5A.
- No host shell command strings are built from bundle values.
- A pre-existing remote branch is never overwritten unless it already points to
  the exact persisted product commit during recovery.

## State files

The Git publish receipt is stored under the Phase 4 execution directory:

```text
execution/publish/git-publish.json
```

Receipt states:

```text
READY_FOR_COMMIT → COMMITTED → PUSHED
```

Phase 5B will consume the `PUSHED` receipt to create or recover one Draft PR.
It is intentionally outside this phase.
