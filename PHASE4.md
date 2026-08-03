# Phase 4 — Agent, Verifier, and Dual Review Boundary

Phase 4 starts from a Phase 3 `READY_FOR_CODEX` receipt and ends only at
`READY_FOR_PUBLISH`. It keeps the accepted bundle immutable, gives agents only
the prepared worktree, derives the change set from Git, runs structured
validation commands through a sandbox, and requires independent Terra and Sol
reviews for the same digest.

The normal test suite injects `FakeAgentClient` and
`FakeVerificationSandbox`. Production `execute` resolves the trusted
`runtime.codex_executable`, constructs the official
`@openai/codex-sdk@0.145.0` client, and performs bounded `codex --version` and
`codex login status` preflight. `CodexVerificationSandbox` performs a smoke
test and runs validation as `codex -c sandbox_workspace_write.network_access=false
sandbox --permission-profile :workspace --cd <canonical-cwd> -- <executable>
<args>`, matching the pinned 0.145.0 CLI contract. The trusted override is
present even when `CODEX_HOME` requests workspace network access. The runtime
preflight rejects other Codex CLI versions.
There is no direct-host fallback. No Phase 4 operation commits, pushes,
invokes GitHub, executes payload files, or automates a browser.

Execution artifacts are stored below
`runs/<task-id>/<archive-sha256>/execution/` using atomic JSON writes and an
append-only state journal. `execution-status` is read-only.

Trusted verification configuration caps changed files, diff lines, file size,
command duration, and command output. Bundle limits are always reduced to the
trusted cap. Model prompts contain only bounded, redacted request/plan,
change-set, and verification evidence; complete transcripts, public reasoning,
and environment values are never persisted. Required verifier failures are
bounded and redacted before being persisted and included in Terra's next
correction prompt alongside validated reviewer findings. The accepted bundle
is never supplied as an SDK writable directory.
