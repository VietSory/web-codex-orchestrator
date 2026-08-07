
# Changelog

## Unreleased

- Hardened Phase 7 Web Review Verdict Processing with exact Task Bundle vs Result Bundle identity separation, selective bounded ZIP reads, hash-bound embedded review contracts and schemas, canonical trusted-run repository bindings, duplicate run identity rejection, integrity-checked terminal retries, complete GitHub head/base repository and SHA attestation, and bounded production GitHub responses.
- Added Phase 7 Web Review Verdict Processing (`wco submit-web-verdict`, `wco web-review-status`), providing secure untrusted verdict intake, per-round immutable storage (`handoff/reviews/runs/<task-id>/<archive-sha256>/rounds/<zero-padded-round>/`), Result Bundle verification, mandatory binding assertions, anti-drip policy enforcement, fresh read-only GitHub attestation, and deterministic dispatch (`APPROVED`, `REVISION_REQUESTED`, `ESCALATED`).
- Added Phase 6 Deterministic Result Bundle Generation and Web Review Handoff, producing a sealed, reproducible ZIP archive containing strictly projected public evidence and safe Git artifact extractions.
- Added Phase 3 inbox scanning, trusted repository routing, exact-base Git
  worktree preparation, run receipts, locks, and schema 1.2 execution policy.
- Hardened Phase 3 worktree ownership cleanup, disabled checkout hooks and
  external filters, and rejected/redacted credential-bearing remote URLs.
- Added Phase 4 schema 1.3 structured validation, trusted agent/verifier
  configuration, isolated execution state machine, dual-review gates, and
  fail-closed Codex/sandbox adapters.
- Hardened Phase 4 runtime/auth and sandbox preflight, cancellation and
  timeout cleanup, Git-ref and bundle immutability checks, bounded/redacted
  review evidence, generated-artifact receipts, trusted change limits, and
  resume repair routing.
- Wired production execution to `@openai/codex-sdk@0.145.0`, including trusted
  runtime configuration, minimal environment preflight, structured output
  schemas, and the concrete Codex verifier sandbox. Required verifier failures
  now produce bounded redacted evidence for the next Terra correction turn.
- Corrected the verifier invocation to the Codex 0.145.0 sandbox CLI contract,
  using `--permission-profile :workspace --cd <canonical-cwd> --` and rejecting
  incompatible Codex CLI versions during preflight.
- Added a trusted root-level `sandbox_workspace_write.network_access=false`
  override to every Codex sandbox invocation, with loopback-denial coverage.
- Switched Phase 4 to the explicitly pinned bundled `@openai/codex@0.145.0`
  runtime and moved real sandbox/execution integrations out of the normal
  deterministic test glob. Global Codex installations are ignored.
