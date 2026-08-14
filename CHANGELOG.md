# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and the project intends to follow Semantic Versioning once tagged releases begin.

## [Unreleased]

### Added

- Zero-config local ChatGPT/Codex transport backed by WCO's pinned official Codex runtime. A fresh normal-user config has no `web_bridge` override; one provider-owned ChatGPT authorization is the only normal external setup interaction.
- Durable semantic author/review state with bounded repository-context requests, canonical prepared-run binding, closed structured output and exact nested authority validation.
- A separate read-only Harness-side Codex implementation planner whose proposal is bound to the canonical job/run before WCO/Harness may apply repository mutations.
- Deterministic zero-config daily-user contract coverage plus an actual packed npm clean-install/compiled-CLI smoke gate.
- Advanced bridge compatibility CI that protects explicitly selected compatibility profiles without making them normal-user fallbacks.

### Changed

- Normal `wco web connect` now delegates ChatGPT authorization/re-authorization to the bundled official Codex runtime; native MCP, managed, relay and manual transports are explicit advanced compatibility paths only.
- Normal `wco web open` is a no-op because local semantic turns run automatically; no per-task ChatGPT browser interaction is required.
- TUI configuration/recovery and slash-command help now describe local ChatGPT/Codex as the zero-config default and fail closed instead of presenting managed/relay/native transport as a normal fallback.
- Cached Codex input tokens remain observable but are not charged twice against the configured total-input budget.
- README, operations guidance, ADR 0004 and user-facing release gates now describe the same local one-authorization product contract.

### Fixed

- Canonical prepared `run_id` is bound back to the local Web bridge before workflow state advances; failed binding cannot leave a false `PREPARED` state.
- The `chatgpt_codex` transport cannot silently fall through to `ManualFileWebBridge`.
- Local Web status distinguishes a healthy runtime from a missing/expired ChatGPT authorization.
- Exact repository-context cache hits are re-attested against the Git blob before use; cache reads are stable/bounded and the disposable cache has a global entry-count ceiling.
- Relay/local semantic durable state validates event journals and idempotency indexes, compacts expired records before capacity checks, and serializes mutations across WCO processes with a crash-recoverable ticket lock so concurrent terminals cannot lose events.
- Local task history uses stable bounded reads and bounded retention; safe legacy history identifiers remain readable while new history writes keep the current UUID format.
- Inbox skip-state is stable-read with a hard byte ceiling and is compacted to candidates currently present in the inbox instead of growing with historical paths forever.
- Provider turns are phase-specific, time-bounded and durably accounted against configured turn/input/output budgets; missing or malformed usage fails closed.
- PAIR completion re-attests the independent Web code-review checkpoint for the exact current Result Bundle instead of trusting a historical approval after restart.
- Post-repair/re-publish resume accepts only the exact published generation or the exact repair-source generation in its valid crash window and rejects a third generation.
- URL-credential log redaction avoids near-quadratic behavior on long scheme-like plaintext while preserving credential redaction; a regression test covers correctness and bounded runtime.
- Missing desktop URL opener commands produce an actionable manual ChatGPT link instead of crashing advanced interactive flows.
- Authenticated GitHub CLI releases that predate `gh auth token` use their supported host-scoped `gh config get oauth_token` fallback without logging the credential.
- First-run setup enters the interactive shell even when credential preflight reports actionable warnings.
- `wco doctor` automatically discovers the saved user config/state paths.
- Repeated setup is idempotent and distinct repositories are registered without replacing existing trusted configuration.
- Web errors retain stable subsystem codes, and bearer-token input is hidden from terminal output.
- Ctrl+C during nested advanced Web setup exits cleanly without a readline implementation error.
- Packed npm self-uninstall remains bound to the exact detected global/local prefix.

### Security

- Semantic author/reviewer and implementation-planning turns remain read-only, no-approval, no-network and provider Web-search-disabled in the current release candidate.
- Provider output is phase-restricted and revalidated through WCO's existing closed authority schemas; Harness remains the only repository mutation/test/Git authority.
- Sealed contracts remain bound to the original job, exact repository and original user intent; implementations remain bound to the canonical prepared run.
- Provider-turn reservation/idempotency fails closed on ambiguous authoring, implementation and final-review replay.
- Local sessions, relay state, read-coverage evidence and advanced credentials use bounded stable/no-follow reads; network/tunnel responses are deadline- and size-bounded.
- No normal local failure silently selects relay, managed, native-MCP, browser-scraping or manual-credential paths.
- Publication, merge, Mark Ready, deployment, destructive Git operations and release remain human-owned.

### Validation

- Main exact-head CI validates dependency/lock/runtime identity, Task Bundle templates, strict TypeScript, deterministic unit/integration tests, context benchmark, E2E, build, compiled CLI integration, package surface, clean packed install and zero-config daily-user contract.
- Regression coverage includes exact Git-cache authority, durable-store corruption, expired-state compaction, concurrent relay mutation serialization, bounded context/history/inbox retention, provider budgets, repair/resume authority and current PAIR review re-attestation.
- A real local ChatGPT authorization + goal-to-reviewed-Draft-PR + restart/recovery acceptance remains required before normal-user release qualification.

## [0.3.0] - 2026-08-10

### Added

- First-run setup and a plain-terminal interactive `wco` shell with the user-facing slash palette.
- Authenticated ChatGPT Web bridge abstraction, bounded reference relay, exact-base repository reads, and durable read receipts.
- Deterministic local materializers for Task Bundle 1.3, Web Implementation Pack v2, and canonical Web verdict submission.
- `gh_cli` credential mode, `/web` connection controls, and conservative WCO-owned resource uninstall.

### Security

- Relay state remains transport only; every artifact and verdict passes the existing local authority validators.
- Web reads deny sensitive paths and never read uncommitted working-tree content by default.
- Publication, merge, Mark Ready, deployment, destructive Git operations, and release remain human-owned.

### Planned

- Public release artifacts, SBOM, checksums, and provenance/attestation after native release validation.

## [0.2.0] - 2026-08-09

### Added

- `wco preview <task-bundle.zip>` for secure, no-worktree/no-network task inspection before repository mutation.
- `wco run <task-bundle.zip>` as the primary bounded durable workflow entry point.
- Human-readable workflow progress and WCO-owned model/token accounting in `wco status`.
- Codex verification-sandbox readiness to `wco doctor`; failed sandbox preflight never falls back to unrestricted verification.
- Deterministic least-privilege Smart Context for Terra/Sol review, derived only from already-bound Web read coverage/project-map/prohibition evidence.
- Repeatable offline Smart Context selector benchmark and an opt-in real Codex A/B benchmark harness for provider-reported tokens, latency, and exact-digest approval rate.

### Changed

- Draft PR descriptions now present exact verified head/change-set/review evidence instead of internal phase labels.
- `wco resume` is documented and presented as clearing an explicit operator pause; recovery/re-attestation executes on the next workflow transition, not inside `resume` itself.
- Initial Terra/Sol review usage is durably propagated into executor/orchestration accounting and adopted exactly once during safe recovery.
- Review prompts JSON-quote repository paths and escape Unicode line/bidi controls so filenames remain data rather than prompt instructions.

### Security

- Executor review turns are durably reserved before provider calls; model-turn and wall-clock budgets can stop a call before it starts.
- Provider-reported token usage is persisted after responses and can stop later calls; missing/malformed usage fails closed. This is intentionally not advertised as a strict current-call provider billing cap.
- Interrupted executor Terra/Sol calls with no sealed verdict fail closed instead of being replayed automatically.
- Revision checkpoints that may span an unsealed provider-backed turn fail closed as ambiguous recovery instead of replaying a model call.
- Smart Context cannot expand the read surface from project-map-only nodes and excludes registered prohibited paths plus hard-sensitive Git/.env paths.
- Preview re-reads accepted authority through bounded stable non-symlink reads to close pathname replacement/TOCTOU gaps.

### Validation

- Exact-head CI validates templates, strict TypeScript, deterministic/unit tests, the offline context benchmark, E2E workflow, build, compiled CLI integration, and `npm pack --dry-run`.
- Real Codex A/B benchmarking is opt-in and intentionally excluded from CI; WCO does not fabricate provider cost/quality claims without an authenticated native run.

## [0.1.0] - 2026-08-09

### Added

- Secure Task Bundle intake and isolated Git worktree preparation.
- Web implementation authority registration with content-addressed bindings.
- Deterministic apply, verification, Terra review, and Sol review.
- Exact Git publication and Draft pull-request delivery with no force-push or automatic merge.
- Result Bundle packaging, explicit Web verdict handling, and bounded same-PR revision orchestration.
- Durable run ledger, crash recovery, bounded retry/circuit behavior, and exact-head CI.