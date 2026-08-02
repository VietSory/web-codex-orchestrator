# Phase 3 coverage map

The Phase 3 cases are intentionally grouped where one test asserts several
independent contract fields. The ranges below are traceable to the named test
or regression suite; they are not claims that untrusted input is executed.

| Cases | Traceable test coverage |
| --- | --- |
| P3-001 | `tests/phase3.test.ts` — `P3-001: schema 1.2 contract validates` |
| P3-002 | `tests/phase3.test.ts` — `P3-002: schema 1.1 is accepted by intake but blocked by prepare` |
| P3-003–P3-012 | `tests/phase3.test.ts` — `P3 contract rejects HEAD and unsafe delivery policy`; assertions cover repository ID, full commit, branch prefix/deny list, delivery branch, draft, auto-merge, gates, and Git policy flags. |
| P3-013–P3-020 | `tests/phase3.test.ts` — `P3 prepare creates an isolated clean worktree and is idempotent`; trusted registry resolution, exact base, clean source repository, receipt, and repeated preparation are asserted. |
| P3-021–P3-030 | `tests/phase3.test.ts` — `P3 config rejects unknown fields and symlink paths`, plus the ZIP intake regression suite for lifecycle/path policy and stable structured errors. |
| P3-031–P3-040 | `tests/phase3.test.ts` — `P3 inbox scan processes a stable candidate once` and `P3 CLI scan emits human output by default and one JSON object with --json`; lexical candidate filtering, stability, index skip, and output contract are covered. |
| P3-041–P3-050 | `tests/phase3.test.ts` — `P3 worktree race: a branch created after the preflight survives failed preparation`; worktree ownership, branch collision, cleanup ownership, and source repository preservation are asserted. |
| P3-051–P3-060 | `tests/zip-intake.test.ts` — ZIP-027 through ZIP-051; duplicate archive idempotency, partial extraction cleanup, payload non-execution, lifecycle symlinks, reserved names, trailing dot/space, length limits, unsupported compression/types, and ancestor collisions. |
| P3-061–P3-073 | `tests/phase3.test.ts` and `tests/zip-intake.test.ts`; run/index persistence, stable error/exit behavior, no payload/validation execution, and remote-ref non-mutation are covered by the integration fixtures. |
| P3-074 | `tests/phase3.test.ts` — `P3-074: post-checkout hooks cannot run during worktree preparation` |
| P3-075 | `tests/phase3.test.ts` — `P3-075: external smudge filters are blocked before checkout` |
| P3-076 | `tests/phase3.test.ts` — `P3-076: credential-bearing HTTP remotes are rejected without leaking the token` |
| P3-077 | `tests/phase3.test.ts` — `P3-077: reference-transaction hook is disabled during branch/worktree preparation` |
| P3-078 | `tests/phase3.test.ts` — `P3-078: reference-transaction hook is disabled during an allowlisted fetch` |
| P3-079 | `tests/phase3.test.ts` — `P3-079: cleanup branch deletion is protected from reference-transaction hooks` |
| P3-080 | `tests/phase3.test.ts` — `P3-080: every GitCommandResult from a runtime-bound runner carries hook protection` |

All Git fixtures use temporary local repositories and bare remotes. They do
not contact public networks, push refs, invoke payloads, run validation
commands, start Codex, call GitHub, or automate a browser.
