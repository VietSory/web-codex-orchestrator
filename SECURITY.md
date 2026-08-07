# Security boundary

Downloaded bundles are untrusted. Phase 4 treats accepted bundles as immutable
metadata, never runs `payload/`, and never copies payload files into a target
repository. Agents cannot select repositories, models, network access,
sandbox mode, credentials, or verifier limits. Validation commands are
structured argument arrays, checked against a trusted executable/environment
policy, and run only through the production Codex sandbox (`codex -c
sandbox_workspace_write.network_access=false sandbox --permission-profile
:workspace --cd <canonical-cwd> -- ...`) or a fake sandbox in tests. The
trusted root-level override prevents `CODEX_HOME` configuration from enabling
workspace network access. The runtime is pinned to the compatible Codex CLI
contract. There is no unsandboxed
fallback. The SDK receives only a minimal trusted environment; provider,
SSH, token, preload, and arbitrary process variables are excluded. Reviews
and verification are invalidated whenever the exact change-set digest changes.

The trusted runtime is `{ "source": "bundled", "codex_home": "..." }`, with
`codex_home` optional and absolute when configured. WCO resolves the pinned
`@openai/codex@0.145.0` package from its own installation and never uses a
global `codex` executable, environment-selected executable, or a
bundle-supplied path.
The accepted bundle is read by the orchestrator and
bounded content is placed in prompts; it is not an additional writable SDK
root. Deterministic verifier failures are redacted and bounded before being
stored in receipts, artifacts, or Terra correction prompts.

## Phase 7 Web review boundary

Phase 7 treats both the Web verdict and the Result Bundle path as security
boundaries. The Result Bundle is independently verified before review data is
trusted, and the Web verdict is size-bounded, canonicalized, schema-validated,
and bound to the exact Task Bundle run, Result Bundle, manifest, spec set,
published commit, Draft Pull Request, and reviewed entry set.

Phase 7 review state is stored only below the configured state directory.
Lifecycle directories are created one component at a time and existing
symbolic-link ancestors or non-directories are rejected. Canonical review
artifacts are read as regular non-symlink files and immutable artifacts are
create-only with exact compare-and-adopt semantics. A per-round lock is owned
by PID plus a random nonce. Existing locks are never automatically stolen or
removed, including apparently stale locks, because path-based stale-lock
reclamation has a replacement race; operator recovery is deliberately
fail-closed.

Every terminal decision is authorized by fresh, read-only GitHub state. The
Pull Request must still be open, unmerged, and Draft, with exact head/base
repository identities, branches, head SHA, and base SHA. Exact retries re-run
this attestation rather than reusing stale approval authority. Production
GitHub access is pinned to `https://api.github.com`, has a 10-second request
timeout, and reads response bodies incrementally with a hard 1 MiB cap.
Phase 7 never commits, pushes, marks a PR Ready, modifies a PR, or merges.
