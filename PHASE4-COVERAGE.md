# Phase 4 coverage map

This map is the index for the acceptance matrix in `test.md`. Every matrix
identifier is listed here or in a test name. The normal suite uses only local
temporary repositories, `FakeAgentClient`, and `FakeVerificationSandbox`; it
does not invoke Codex/OpenAI, a browser, payloads, public network, commits,
pushes, or Pull Requests.

## Direct integration coverage

`tests/phase4.test.ts` exercises the core contract, state, path, verifier,
review, and terminal gates for: `P4-001`, `P4-002`, `P4-003`, `P4-004`,
`P4-005`, `P4-006`, `P4-007`, `P4-008`, `P4-009`, `P4-010`, `P4-011`,
`P4-012`, `P4-013`, `P4-018`, `P4-019`, `P4-020`, `P4-024`, `P4-025`,
`P4-026`, `P4-027`, `P4-033`, `P4-034`, `P4-035`, `P4-036`, `P4-037`,
`P4-038`, `P4-039`, `P4-040`, `P4-041`, `P4-043`, `P4-044`, `P4-045`,
`P4-046`, `P4-047`, `P4-048`, `P4-049`, `P4-050`, `P4-053`, `P4-055`,
`P4-056`, `P4-057`, `P4-058`, `P4-069`, `P4-070`, `P4-071`, `P4-072`,
`P4-073`, `P4-074`, `P4-084`, `P4-085`, `P4-086`, `P4-087`.

## Hardening and lifecycle coverage

`tests/phase4-hardening.test.ts` covers the following focused regressions:

- `P4-H-001`: reserved environment keys and npm/network subcommands;
- `P4-H-002`: no unrestricted host-sandbox fallback;
- `P4-H-003`: refs, hooks, config, and staged metadata in the change digest;
- `P4-H-004`: symlink, special-file, ancestor, and maximum-file-size policy;
- `P4-H-005`: verifier source mutation and generated artifacts;
- `P4-H-006`: assessment/repair turns and cached-token accounting;
- `P4-H-007`: interrupted/resumable state transitions;
- `P4-H-008`: explicit thread start/resume lifecycle;
- `P4-H-009`: bounded and redacted verifier output;
- `P4-H-010`: atomic, redacted artifact writes;
- `P4-014`, `P4-015`, `P4-016`, `P4-017`: receipt/worktree/base/branch and
  accepted-bundle integrity checks;
- `P4-021`, `P4-022`, `P4-023`: assessment stop/mutation gates;
- `P4-028`, `P4-029`, `P4-030`, `P4-031`, `P4-032`: special files, commits,
  branch changes, and Git metadata protection;
- `P4-042`, `P4-051`, `P4-052`: timeout, tracked-source mutation, and allowed
  generated artifacts;
- `P4-054`, `P4-059`, `P4-060`, `P4-061`, `P4-062`, `P4-063`, `P4-064`,
  `P4-065`, `P4-066`, `P4-067`, `P4-068`: Terra review thread, digest,
  finding, rerun, and budget gates;
- `P4-075`, `P4-076`, `P4-077`, `P4-078`, `P4-079`, `P4-080`: Sol review
  outcomes, stale approvals, mutation, and finding gates;
- `P4-081`, `P4-082`, `P4-083`: required verifier and multi-round ordering;
- `P4-088`, `P4-089`, `P4-090`: post-review worktree changes and stale Sol
  approval rejection;
- `P4-091`, `P4-092`, `P4-093`, `P4-094`: iteration, review-round, token, and
  turn-time budgets;
- `P4-095`, `P4-096`, `P4-097`, `P4-098`, `P4-099`, `P4-100`: terminal
  idempotence, interruption resume, receipt consistency, execution locks,
  JSON execution output, and status;
- `P4-101`, `P4-102`, `P4-103`, `P4-104`, `P4-105`, `P4-106`: payload/network/
  credential isolation, prompt redaction, and signal cleanup;
- `P4-107`, `P4-108`: Phase 1–3 regression and normal-CI no-provider guard.

The remaining matrix behavior is enforced by the same shared validators and
service gates and is named above so coverage cannot silently drift. The
optional `tests/codex-integration.test.ts` suite is opt-in and skips in normal
CI; it never supplies credentials or enables network access.

The production wiring regressions are covered by
`tests/codex-sdk-client.test.ts` for new/resumed SDK threads, restrictions,
structured output, cancellation, bounded events, and environment filtering;
`tests/codex-sandbox.test.ts` for platform argv, bounded process options, and
fail-closed startup; and `tests/verifier-fix-evidence.test.ts` for redacted
verifier feedback in Terra's next correction prompt and persisted artifacts.
The real integration test consumes Codex usage only when explicitly enabled.
