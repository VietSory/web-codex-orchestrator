# Phase 14 — Durable Web Verdict Orchestration

## Goal

Phase 14 connects the existing hardened Phase 7 Web Review service to the durable orchestration ledger. WCO waits without spending an attempt until an explicit verdict file is supplied, seals the canonical verdict SHA-256, processes exactly those sealed bytes, and routes only the resulting terminal decision. It never scrapes a browser, ChatGPT session, Codex transcript, or resume history for authority.

## Frozen invariants

1. `WAIT_WEB_VERDICT` is quiescent while no `web_verdict_path` input exists; waiting does not consume retry/model/token budget.
2. The untrusted verdict source is read with the existing bounded stable-file reader and canonicalized before a durable transition attempt is checkpointed.
3. The transition request binds only the canonical verdict SHA-256, not a mutable filesystem path.
4. After checkpointing, orchestration writes the already-attested canonical bytes to a private temporary file and passes that immutable copy to the existing Phase 7 service. A source-path TOCTOU cannot substitute different verdict bytes after the attempt is sealed.
5. Phase 7 remains authoritative for exact Result Bundle selection, embedded schema validation, immutable review-history validation, review policy, per-round locking/idempotency, and fresh read-only GitHub attestation.
6. Completion requires a terminal `APPROVED`, `REVISION_REQUESTED`, or `ESCALATED` receipt whose verdict digest equals the sealed request, whose decision event is sealed, and whose freshly attested Draft PR head equals the published commit.
7. `APPROVED` and `ESCALATED` route only to `WAIT_HUMAN`. WCO never marks Ready, merges, auto-merges, deletes branches, or weakens merge authority.
8. `REVISION_REQUESTED` routes only to the `REVISE` boundary owned by Phase 15.
9. Snapshot planning derives Web-review state from bounded durable Phase 7 receipts, never from UI/session state.

## Crash recovery

Phase 14 closes the post-publish crash window for `OPEN_DRAFT_PR`, `PACKAGE_RESULT`, and `WAIT_WEB_VERDICT` attempts. Recovery first re-checks the sealed request. Draft-PR recovery reuses the idempotent Phase 12 GitHub state machine, Result-Bundle recovery reuses the idempotent Phase 13 packaging/verification service, and Web-verdict recovery re-submits the already persisted canonical verdict through Phase 7's idempotent path so a fresh GitHub head attestation occurs before the terminal decision is adopted.

A recovered verdict path must resolve strictly below the state directory. A mismatched request digest, changed Draft PR head, changed Result Bundle binding, changed verdict digest, missing decision event, or failed fresh GitHub attestation is a recovery conflict rather than authority to continue.

## Security and resource behavior

Verdict files are bounded to the existing 1 MiB limit and stable-read checks. The temporary canonical verdict directory is randomly generated, permission-restricted where supported, contains only the already canonicalized verdict bytes, and is removed in `finally`. Durable orchestration continues to cap ledger bytes, event history, diagnostics, retries, elapsed time, model turns, and token counters.

Verdict ingestion itself consumes no model turn. There is no global Codex session enumeration, resume-picker dependency, conversation replay, browser lifecycle, or transcript cache. This shields WCO control flow from upstream Codex session/history CPU and RAM failure modes while leaving Codex app/CLI/agent internals untouched.

## Tests

`tests/phase14-web-verdict-orchestration.test.ts` covers input-wait behavior, exact-digest APPROVE routing, REVISE routing, fresh-head drift failure, and crash recovery with mandatory idempotent revalidation. The full suite continues to exercise Phase 7 schema, policy, GitHub attestation, history, lock, path, and persistence regressions.

## Boundary after Phase 14

A sealed `REVISION_REQUESTED` decision advances to `REVISE`; Phase 15 owns durable revision execution and revision Result Bundle production. Human merge authority remains outside autonomous WCO operation.
