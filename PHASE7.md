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

## Per-Round Immutable Storage

Storage path per review round:
```text
handoff/reviews/runs/<task-id>/<archive-sha256>/rounds/<zero-padded-round>/
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

## CLI Commands

```bash
# Ingest and process a Web review verdict
wco submit-web-verdict \
  --run-id <task-id:archive-sha256> \
  --state-dir <directory> \
  --config <config.json> \
  --verdict <path> \
  [--json]

# Read-only status query
wco web-review-status \
  --run-id <task-id:archive-sha256> \
  --state-dir <directory> \
  [--round <1-4>] \
  [--json]
```
