# Changelog

## Unreleased

- Added Phase 8 Same-PR Revision Loop (`wco revise`, `wco revision-status`): consumes only a sealed Phase 7 `REVISE` request, reuses the existing isolated worktree and Draft PR branch, performs bounded implementation plus deterministic verification/Terra/Sol review, appends exactly one normal commit, performs a normal fast-forward push, and creates a deterministic Result Bundle v1.2 for the next Web review round.
- Hardened Phase 8 authority and recovery boundaries: re-attest the accepted Task Bundle against the previously sealed bundle tree before revision work; rebind mutable revision checkpoints to canonical Phase 3/7/config authority; verify remote URL before every network Git operation; freshly attest the same open/unmerged Draft PR immediately before an actual push; require exact review-round-to-Result-Bundle semantics; verify the complete v1.2 previous-bundle/verdict/request/head chain in Phase 7; and reuse independently verified ready revision archives after crash/retry instead of rebuilding with new bytes.
- Added Phase 8 maintainer/adversarial coverage for remote replacement, pre-revision Task Bundle mutation even after checksum recomputation, mutable checkpoint authority tampering, Result Bundle version/round masquerading, broken revision history chains, ready Result Bundle crash recovery, and a full fake `REVISE -> same PR revision -> Result Bundle v1.2 -> Web APPROVE` end-to-end path.
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
