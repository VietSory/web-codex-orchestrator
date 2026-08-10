# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and the project intends to follow Semantic Versioning once tagged releases begin.

## [Unreleased]

### Fixed

- Authenticated GitHub CLI releases that predate `gh auth token` now use their supported host-scoped `gh config get oauth_token` fallback without logging the credential.
- README Latest-release links and version checks now point at the published v0.3.2 artifact.
- First-run setup now completes and enters the interactive shell even when credential preflight reports actionable warnings.
- `wco doctor` automatically discovers the saved user config/state paths.
- Repeated setup is idempotent and distinct repositories are registered without replacing existing trusted configuration.
- Disconnected Web status no longer reports the local fallback bridge as connected.
- Web errors retain stable subsystem codes, and bearer-token input is hidden from terminal output.
- Ctrl+C during nested Web setup exits cleanly without a readline implementation error.
- Packed npm self-uninstall is bound to the exact detected global/local prefix.

### Added

- A reusable clean-pack/install/PTTY/uninstall/reinstall daily-user gate: `npm run test:user:packed`.
- Hosted CI coverage for the packed daily-user journey.

### Changed

- README and operations guidance now describe the released interactive Web-first workflow; internal Task Bundle/run-ID commands are explicitly advanced automation.

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
