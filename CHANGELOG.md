
# Changelog

## Unreleased

- Added Phase 2 secure ZIP intake and Bundle Contract v1.1 checksum/payload validation.
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
