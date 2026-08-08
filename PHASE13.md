# Phase 13 — Durable Result Bundle Orchestration

## Goal

Phase 13 extends the durable control plane across `PACKAGE_RESULT` by reusing the existing hardened Phase 6 Result Bundle implementation. WCO packages only the already-attested published Draft PR head and advances only when the durable Result Bundle receipt is `READY_FOR_WEB_REVIEW` for the exact run and exact published head.

## Frozen invariants

1. `PACKAGE_RESULT` uses the same durable checkpoint, transition lock, retry budget, diagnostic compaction, and crash-recovery rules as prior external transitions.
2. The currently selected registered Web artifact and exact `READY_FOR_PUBLISH` executor snapshot are re-attested before packaging is sealed.
3. Packaging reuses `packageResultBundle`; Phase 13 does not introduce a second ZIP builder, Git evidence reader, GitHub attestation implementation, or receipt format.
4. Result readiness comes only from the bounded durable Result Bundle receipt. Browser tabs, ChatGPT/Codex sessions, CLI transcript history, cached UI state, or model output are never lifecycle authority.
5. Completion requires `READY_FOR_WEB_REVIEW`, the exact `run_id`, a verified archive SHA-256, `published_commit_sha === remote_branch_sha`, an open Draft PR attestation whose `head_sha` equals that published commit, and the reviewed-entry-set digest produced by the Result Bundle verifier.
6. The existing Result Bundle lock and idempotency behavior remain authoritative. A retry may reconcile/re-verify the same archive but must not create an alternative handoff for the same exact run.
7. `WAIT_WEB_VERDICT` remains a quiescent boundary. Phase 13 does not fabricate or scrape a Web verdict and does not resume Codex history to infer one.
8. Ready-for-review, merge, branch deletion, force-push, auto-merge, deployment, and publication remain forbidden.

## Security and recovery

The production adapter loads only trusted local configuration, reads the configured GitHub token from its environment key, and passes that token to the existing GitHub attestation client. The token is also supplied to the existing Result Bundle secret scan so it cannot be emitted into the handoff archive. Git commands are executed with `shell: false` and `GIT_TERMINAL_PROMPT=0`; stderr persisted through orchestration diagnostics is bounded to 4096 characters.

The Result Bundle service already validates upstream execution, push, Draft PR, GitHub and Git evidence, builds a deterministic archive under an exclusive lock, verifies the archive, and writes the durable receipt atomically. The orchestration layer treats that service as the source of truth rather than duplicating its recovery semantics.

## Performance, session lifecycle and token boundaries

`PACKAGE_RESULT` performs deterministic local/Git/GitHub evidence work and consumes no model turn. Snapshot planning reads one bounded receipt directly by exact run path; it does not scan global Codex sessions, browser history, transcripts, or unrelated state directories. Existing archive limits, GitHub response limits, output bounds, deterministic entry sets, and receipt size limits remain in force.

This deliberately shields WCO from upstream session-history/resume CPU/RAM problems: no control-plane transition depends on replaying or deserializing model conversations. WCO documents such upstream behavior only as a compatibility boundary and does not modify OpenAI Codex app/CLI/agent internals.

## Tests

`tests/phase13-result-bundle-orchestration.test.ts` verifies:

- one durable `PACKAGE_RESULT` attempt advances only after an exact verified Draft-PR-bound handoff;
- wrong PR head fails closed and preserves the packaging boundary;
- `READY_FOR_WEB_REVIEW` is quiescent and does not repackage.

The complete unit suite continues to exercise the underlying Phase 6 Result Bundle builder, archive verifier, Git evidence, GitHub attestation, receipt validation, locks, and secret scanning.

## Boundary after Phase 13

A verified initial Result Bundle advances to `WAIT_WEB_VERDICT`. Phase 14 owns durable ingestion/validation of the Web verdict. Revision execution remains a later boundary. Human merge authority remains outside autonomous WCO operation.
