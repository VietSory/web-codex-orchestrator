# Phase 14 — Durable Web Verdict Orchestration

## Goal

Phase 14 extends the durable control plane across `WAIT_WEB_VERDICT` by reusing the hardened Phase 7 Web Review service. A Web-authored verdict is treated as bounded untrusted input, canonicalized, staged under the exact run, sealed into the orchestration ledger, validated against the exact Result Bundle and fresh GitHub Draft PR head, and then dispatched only to the existing human-merge or revision boundaries.

Phase 14 does not automate ChatGPT Web, scrape browser state, infer a verdict from a transcript, or change OpenAI Codex internals.

## Transition

```text
READY_FOR_WEB_REVIEW
        ↓
WAIT_WEB_VERDICT
        ├── no verdict input → quiescent / needs verdict_path
        ├── policy/contract blocked → WAIT_HUMAN
        ├── operational failure → bounded retry of the same staged digest
        ├── APPROVED → WAIT_HUMAN (human merge authority)
        ├── ESCALATED → WAIT_HUMAN
        └── REVISION_REQUESTED → REVISE
```

`REVISE` remains a Phase 15 execution boundary. Phase 14 only proves that the revision request was produced by the exact terminal Phase 7 review of the exact Result Bundle and exact freshly attested PR head.

## Frozen invariants

1. Phase 7 schemas, history validation, anti-drip policy, Result Bundle selection, GitHub attestation and decision-event/revision-request formats remain authoritative; Phase 14 does not fork or weaken them.
2. A verdict source is bounded to the existing Phase 7 1 MiB limit, must be a stable regular file, must not be a symlink/special file, and is canonicalized before its SHA-256 is used as transition identity.
3. The staged verdict lives under `orchestration/runs/<task>/<bundle>/inputs/` and is named by review round. Only four fixed round slots exist, so retries cannot create unbounded verdict-file growth.
4. An in-flight verdict attempt is sealed as `{ verdict_sha256, review_round }`. A different verdict is rejected before it can overwrite the staged input for that sealed attempt.
5. Crash recovery first adopts an already-terminal Phase 7 receipt only when its exact verdict digest/round matches the sealed orchestration request. If Phase 7 was not yet invoked, WCO can recover the exact staged file by the sealed request without asking a model/session to reconstruct it.
6. Operational `FAILED`/`RETRYABLE` Web Review state remains eligible only for bounded orchestration retry; policy/contract `BLOCKED` state requires human recovery.
7. Terminal success requires `APPROVED`, `REVISION_REQUESTED`, or `ESCALATED`, plus the exact run, valid Result Bundle/verdict SHA-256 values, and `fresh_attested_head_sha === observed_head_sha === published_commit_sha`.
8. `APPROVED` is valid only with `ASK_USER_TO_MERGE`; WCO never merges or marks the PR Ready. `REVISION_REQUESTED` is valid only with `NO_USER_MERGE_PROMPT` and an exact revision-request SHA-256.
9. No force-push, merge, deployment, release, package publication, browser automation, transcript replay, or model call is introduced by this phase.
10. Existing run locks, transition locks, retry budgets, circuit state, diagnostics compaction and event-ledger bounds remain authoritative.

## CLI and input lifecycle

`wco-control continue` accepts an optional one-shot Web verdict input:

```bash
wco-control continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir <state-directory> \
  --config <trusted-config.json> \
  --verdict <web-verdict.json> \
  [--web-pack <registered-web-pack.zip>] \
  [--max-transitions 1..32] \
  [--json]
```

The verdict path is consumed after one successful `WAIT_WEB_VERDICT` transition. It is not silently replayed into a later review round after a revision. If no verdict is available, the controller reports `needs_input: "verdict_path"` and does no review/network/model work.

The loop no longer stops merely because the next already-hardened transition is `OPEN_DRAFT_PR` or `PACKAGE_RESULT`; it can progress through those transitions until a true external-input, revision, retry-backoff, or human boundary is reached.

## Security and recovery

Verdict staging uses a private run directory, temporary `wx` creation, bounded canonical bytes, and a same-directory rename. Existing staged targets must be regular non-symlink files. Resume input is digest-checked before replacement, preventing a different file from destroying the canonical staged evidence for an active request.

The Phase 7 service independently revalidates the verdict schema, immutable review history, policy bindings and fresh GitHub authority immediately before terminal dispatch. Orchestration does not trust its own staged filename as review authority; the terminal receipt must re-bind the exact digest and exact PR head.

Retry backoff is honored before a new transition attempt is started. A retryable Phase 7 receipt may reuse only the staged verdict whose SHA-256 matches that receipt. Policy-blocked review does not auto-retry.

## CPU, RAM, state and token discipline

Phase 14 uses no model turn. Recovery examines at most four fixed staged verdict files and at most four bounded Phase 7 review receipts. It does not enumerate global Codex sessions, load browser history, replay a chat transcript, or rebuild project context.

This is also a compatibility shield for session/resume problems outside WCO. OpenAI documents the Codex SDK as supporting built-in context management/resumption, but WCO does not elevate that session context into durable control-plane authority. Relevant upstream reports include:

- OpenAI Codex GA / SDK overview: https://openai.com/index/codex-now-generally-available/
- full-history resume rendering / performance: https://github.com/openai/codex/issues/34663
- very large local session resume RAM/OOM: https://github.com/openai/codex/issues/28866
- large-session interactive resume picker freeze: https://github.com/openai/codex/issues/25430

Those are negative requirements for WCO: lifecycle recovery must remain possible from bounded run-scoped files and exact hashes even when a Codex/browser session is slow, missing, corrupt, or unsafe to resume. WCO does not patch OpenAI Codex app/CLI/agent internals.

## Tests and release gate

`tests/phase14-web-verdict-orchestration.test.ts` covers:

- quiescent missing-input behavior;
- exact `APPROVED → WAIT_HUMAN` dispatch;
- exact `REVISION_REQUESTED → REVISE` dispatch;
- stale fresh PR head fail-closed behavior;
- adoption of an exact terminal receipt after a crash;
- rejection of resumed verdict drift before staged evidence can be overwritten.

Run:

```bash
npm run test:phase14
npm run phase14:release-gate
```

Normal CI remains fake/offline for model work; it does not authenticate to Codex or consume model quota.

## Boundary after Phase 14

A sealed `REVISION_REQUESTED` review advances to `REVISE`. Phase 15 owns durable same-PR revision execution and packaging by reusing Phase 8. `APPROVED` and `ESCALATED` remain human boundaries. Merge remains human-only.
