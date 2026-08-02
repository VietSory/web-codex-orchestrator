# Phase 4 — Agent, Verifier, and Dual Review Boundary

Phase 4 starts from a Phase 3 `READY_FOR_CODEX` receipt and ends only at
`READY_FOR_PUBLISH`. It keeps the accepted bundle immutable, gives agents only
the prepared worktree, derives the change set from Git, runs structured
validation commands through a sandbox, and requires independent Terra and Sol
reviews for the same digest.

The normal test suite injects `FakeAgentClient` and
`FakeVerificationSandbox`. `CodexSdkAgentClient` and
`CodexVerificationSandbox` fail closed unless a supported runtime is injected.
No Phase 4 operation commits, pushes, invokes GitHub, executes payload files,
or automates a browser.

Execution artifacts are stored below
`runs/<task-id>/<archive-sha256>/execution/` using atomic JSON writes and an
append-only state journal. `execution-status` is read-only.
