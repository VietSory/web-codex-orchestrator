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

## Executor-to-Phase-6 compatibility boundary

Phase 10–12 state is intentionally artifact-scoped under:

```text
executor/runs/<task>/<task-bundle-sha>/artifacts/<artifact-sha>/
```

whereas the frozen Phase 6 builder consumes the original Phase 4/5 compatibility layout. Phase 13 therefore does **not** ask Phase 6 to discover or guess the newer state topology.

Before packaging, the production adapter:

1. resolves the selected Phase 9 artifact and re-attests the exact Phase 10 `READY_FOR_PUBLISH` executor snapshot;
2. reads the exact executor-scoped Phase 11 `git-publish.json` and Phase 12 `github-draft-pr.json` and binds both to the same run/change-set/published head;
3. creates a private temporary compatibility root below the WCO state directory;
4. projects only the already-attested Phase 10 execution/review/verification summary into the frozen Phase 4 execution-receipt shape and copies the exact Phase 11/12 receipts into the legacy paths expected by Phase 6;
5. invokes the unchanged `packageResultBundle` against that compatibility root;
6. verifies and durably promotes only the resulting archive and receipt into the canonical `handoff/runs/...` location; and
7. removes the temporary compatibility root.

The compatibility projection is an adapter, not a new authority source. Canonical Phase 3/9/10/11/12 evidence is re-attested before projection, and the Phase 6 archive remains the only Result Bundle format consumed by later review phases.

## Security and recovery

The production adapter loads only trusted local configuration, reads the configured GitHub token from its environment key, and passes that token to the existing GitHub attestation client. The token is also supplied to the existing Result Bundle secret scan so it cannot be emitted into the handoff archive.

Git evidence subprocesses use the common bounded process primitive with `shell: false`, `GIT_TERMINAL_PROMPT=0`, a fixed deadline, bounded stdout/stderr retention and process-group cleanup. Binary Git evidence is kept as bytes rather than reconstructed from UTF-8 text. Persisted orchestration diagnostics retain only bounded tails.

The Result Bundle lock uses create-only ownership with a random nonce; an existing stale lock is diagnosed but never stolen automatically. Result Bundle receipts use bounded stable no-follow reads and durable temp-file + fsync + rename persistence.

The Result Bundle service validates execution, push, Draft PR, GitHub and Git evidence, builds a deterministic archive under the exclusive lock, verifies the archive, and writes the durable receipt. The orchestration layer treats that service as the source of truth rather than duplicating its archive/review semantics.

## Performance, session lifecycle and token boundaries

`PACKAGE_RESULT` performs deterministic local/Git/GitHub evidence work and consumes no model turn. Snapshot planning reads one bounded receipt directly by exact run path; it does not scan global Codex sessions, browser history, transcripts, or unrelated state directories. Existing archive limits, GitHub response limits, output bounds, deterministic entry sets, and receipt size limits remain in force.

This deliberately shields WCO from upstream session-history/resume CPU/RAM problems: no control-plane transition depends on replaying or deserializing model conversations. WCO documents such upstream behavior only as a compatibility boundary and does not modify OpenAI Codex app/CLI/agent internals.

## Tests

`tests/phase13-result-bundle-orchestration.test.ts` verifies the durable state-machine boundary, including exact handoff advancement, wrong-head failure and quiescent `READY_FOR_WEB_REVIEW` behavior.

`tests/phase13-production-package-adapter.test.ts` exercises the production storage adapter itself: executor-scoped Phase 10/11/12 state is projected into the exact frozen Phase 6 reader topology, the compatibility root is isolated and removed, and the verified archive/receipt are promoted to the canonical handoff path.

`tests/result-bundle-lock-hardening.test.ts` covers simultaneous create-only lock acquisition and refusal to delete a replaced foreign lock.

The Phase 13 release gate runs both the state-machine and production-adapter suites before the complete unit/build/CLI gates.

## Boundary after Phase 13

A verified initial Result Bundle advances to `WAIT_WEB_VERDICT`. Phase 14 owns durable ingestion/validation of the Web verdict. Revision execution remains a later boundary. Human merge authority remains outside autonomous WCO operation.
