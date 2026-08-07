# Phase 7 — Web Review Verdict Processing

## Architecture Overview

Phase 7 implements Web Review Verdict Processing for `web-codex-orchestrator`.
ChatGPT Web serves as the independent reviewer and produces `web-review-verdict.json`. Phase 7 securely ingests that verdict, validates it against the exact Phase 6 Result Bundle, review policy, frozen specification registry, and review history, performs a fresh read-only GitHub attestation immediately before decision dispatch, and deterministically dispatches one of:

* `APPROVED` -> Action `ASK_USER_TO_MERGE`
* `REVISION_REQUESTED` -> Action `NO_USER_MERGE_PROMPT` (generates `revision-request.json`)
* `ESCALATED` -> Action `NOTIFY_USER_EXCEPTION`

## Phase Boundaries & Non-goals

Phase 7 does **not** perform the Web review itself.

Phase 7 must never:
* edit repository source files being reviewed;
* invoke an implementation or review agent;
* commit, push, merge, close, reopen, or modify a Pull Request;
* mark a Pull Request ready;
* execute content from the Result Bundle;
* weaken or silently upgrade existing Web Review schemas;
* implement the Phase 8 revision publisher.

GitHub access in Phase 7 is strictly **read-only** and used solely for fresh attestation.

## Final Trust-Boundary Invariants

Phase 7 is fail-closed on all review authority and repository bindings:

1. `run_id` remains bound to the accepted **Task Bundle** archive SHA. The Phase 6 Result Bundle has an independent `archive_sha256`; the two identities are never conflated.
2. The canonical Phase 3 `runs/<task-id>/<task-bundle-sha>/run.json` is the only trusted run receipt. Alternate handoff paths are not accepted, and duplicate physical receipts claiming the same `run_id` are rejected as ambiguous state.
3. The canonical run receipt must bind `repository_id`, canonical `repository_path`, remote name, and remote URL to the trusted repository registry.
4. The full Result Bundle is independently streamed and verified. Phase 7 selectively reads only bounded review/spec entries; it never buffers all ZIP entries into memory.
5. `WEB-REVIEW-CONTRACT.md`, review policy, verdict schema, revision-request schema, spec lock, and reviewed-entry set are hash-bound through the exact verified Result Bundle manifest and Phase 6 receipt.
6. The exact embedded verdict schema is authoritative for the reviewed bundle. The built-in validator remains a minimum hard floor, so neither side can silently weaken validation.
7. Terminal round retries are idempotent only when verdict, decision event, and (for `REVISE`) revision request still exist and hash exactly to the terminal receipt. A retry must also re-run frozen-policy validation and obtain a **fresh GitHub attestation**; a previously terminal receipt never authorizes a stale merge prompt after repository or PR drift.
8. Every Phase 7 lifecycle directory under `handoff/reviews/` must be a real directory inside the configured state root. Existing symbolic-link ancestors, symbolic-link artifacts, special files, and real-path escapes fail closed. Canonical artifact reads and compare-and-adopt operations never follow symlink targets.
9. The per-round lock is create-only and owner-bound by PID plus nonce. Phase 7 never automatically steals, unlinks, or replaces an existing live, stale, or malformed lock because path-based stale-lock takeover has a replacement race. A stale/malformed lock requires explicit operator recovery after verifying no live owner exists.
10. Fresh GitHub attestation requires the exact PR number, **Draft** state, open/unmerged state, head/base repository identity, head/base branch, head SHA, and base SHA. Production GitHub reads are pinned to `api.github.com`, have a 10-second timeout, and are incrementally capped at 1 MiB even when `Content-Length` is absent or incorrect. Invalid or missing identity fields fail closed.
11. Phase 7 performs no GitHub mutation. Marking a PR Ready and merging remain human-controlled actions outside Phase 7.

## Per-Round Immutable Storage

Storage path per review round:
```text
handoff/reviews/runs/<task-id>/<task-bundle-sha256>/rounds/<zero-padded-round>/
├── web-review-verdict.json
├── web-review-receipt.json
├── decision-event.json
├── revision-request.json (exists only for REVISE)
└── web-review.lock
```

Zero-padded rounds: `01`, `02`, `03`, `04`.

Round rules:
* Initial review: round `1`.
* Revision reviews: rounds `2`, `3`, and `4`.
* A `REVISE` verdict at review round `4` is invalid because it exceeds the maximum budget of 3 revision requests.
* At round `4`, unresolved automation-fixable issues are represented as `ESCALATE`.

## Lock Recovery

A process crash may leave `web-review.lock` behind. Phase 7 intentionally does not reclaim that path automatically. Before manual removal, an operator must verify that no review process still owns the round and that the lock belongs to the expected state directory. The next submission then revalidates all persisted artifacts, hashes, frozen review history, and fresh GitHub state before any terminal action is returned.

## CLI Commands

```bash
wco submit-web-verdict \
  --run-id <task-id:task-bundle-sha256> \
  --state-dir <directory> \
  --config <config.json> \
  --verdict <path> \
  [--json]

wco web-review-status \
  --run-id <task-id:task-bundle-sha256> \
  --state-dir <directory> \
  [--round <1-4>] \
  [--json]
```

## Release Gate

Before Phase 7 is considered releasable, run:

```bash
npm run phase7:release-gate
```

The gate executes typecheck, the deterministic unit/fake integration suite, build, and compiled CLI integration tests. The compiled Phase 7 integration suite includes a real `dist/cli/index.js` success path that reaches `APPROVED` against an isolated mocked HTTP boundary, as well as the fail-closed missing-authentication path. A Phase 7 release/merge recommendation requires the complete gate to pass on the exact PR head SHA.
