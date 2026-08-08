# Changelog

All notable user-facing changes to Web Codex Orchestrator are documented here. The project follows semantic versioning once tagged releases begin.

## [Unreleased]

### Added

- secure Task Bundle validation, archive intake, and isolated worktree preparation;
- content-addressed Web implementation authority and exact operation preimages;
- deterministic constrained execution with verification plus independent Terra and Sol review;
- exact Git publication, Draft pull-request attestation, deterministic Result Bundles, explicit Web verdicts, and bounded same-PR revision;
- durable orchestration with pause/resume, retry backoff, crash recovery, token/time/attempt budgets, and bounded diagnostics;
- one public `wco` CLI with explicit environment defaults for routine control commands;
- package-surface verification and Apache-2.0 licensing.

### Security

- exact-head CI checkout and identity assertion;
- bounded/stable trusted config and durable receipt reads;
- subprocess deadlines and output caps for text and binary Git evidence;
- fail-closed resource ceilings for inbox, archive, model-turn, token, and result-bundle limits;
- symlink/path/remote/PR/race protections across intake, execution, publication, and recovery.

### Changed

- repository documentation is organized by product function instead of historical development phases;
- source-checkout commands and CI use stable purpose-based scripts such as `check`, `test:e2e`, and `test:cli`.
