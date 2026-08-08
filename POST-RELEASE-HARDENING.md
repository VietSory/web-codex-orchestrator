# Post-release hardening

This Draft follow-up keeps the frozen WCO contracts intact while hardening boundaries discovered during final maintainer review.

## Runtime and resource bounds

- Subprocess stdout/stderr is retained as a bounded tail instead of repeatedly copying complete output buffers.
- Local and network Git commands have separate deadlines and bounded output.
- Agent, reviewer, fetch, and GitHub-attestation deadlines remain live until the owned operation settles; cancellation is propagated to the underlying operation.
- Run journal sequencing reads only the final durable JSONL record instead of rereading the complete history for every append. Appends are file-handle-bound and synced.
- Successful native-Codex integration fixtures are removed automatically; failed fixtures are retained only when explicitly requested for diagnostics.

## Security and recovery boundaries

- Production Git uses an isolated runtime with system/global config disabled, empty hooks, and bounded execution.
- Executable repository-local clean/process filters, diff/textconv helpers, credential helpers, transport programs, URL rewrite rules, and HTTP/SSH proxy overrides are rejected at applicable production boundaries.
- Authenticated publish/revision transport is pinned to the trusted canonical remote URL rather than a mutable remote-name lookup.
- All effective fetch and push URLs are checked against the registered allowlist.
- Result Bundle Git evidence uses local-only bounded binary Git reads, disables external diff/textconv, and rejects unsupported Git modes.
- Phase 6 GitHub attestation requires the exact open Draft PR identity, rejects redirects, bounds streamed responses, and uses a live request deadline. Production is pinned to `api.github.com`; only an explicit loopback endpoint is accepted for local integration tests.
- Result Bundle, run, and execution locks use atomic exclusive creation and owner nonces. Release never deletes a replacement lock owned by another process.
- Result Bundle receipts are bounded, stable-read, atomically replaced, synced, and remain bound to a Draft PR before Web review.
- Executor apply failures restore every independently safe registered preimage in reverse order; ambiguous externally changed targets are preserved and escalated rather than guessed.

## Session and recovery authority

Codex thread IDs are bounded runtime optimization state, not WCO recovery authority. WCO resumes from its own receipts, sealed authority artifacts, exact Git identities, verification evidence, and bounded state. Reviewer roles remain independently instantiated and exact change-set digests bind every approval.

## Public grounding

- Node.js timers: https://nodejs.org/api/timers.html
- Node.js file-system durability primitives: https://nodejs.org/api/fs.html
- Git configuration and URL rewrite behavior: https://git-scm.com/docs/git-config
- Git remote URL behavior: https://git-scm.com/docs/git-remote
- Git credential helpers: https://git-scm.com/docs/gitcredentials
- GitHub REST API versioning: https://docs.github.com/en/rest/about-the-rest-api/api-versions
- Codex upstream session/resume issues are treated as compatibility evidence only; WCO does not alter OpenAI internals and does not use Codex thread replay as durable workflow authority.
