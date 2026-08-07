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

Phase 7 treats the canonical Phase 3 run receipt, Phase 6 Result Bundle handoff,
Web verdict, persisted review state, and fresh GitHub response as explicit
security boundaries. The complete authority paths under `runs/` and
`handoff/runs/` must remain inside the configured state root with no symbolic
link in any ancestor. The exact Phase 6 receipt bytes are allocation-bounded,
read through one stable file handle, hash-bound, parsed, and validated from the
same buffer before the independently verified Result Bundle is trusted.

The Web verdict is a regular non-symlink file with an allocation-safe 1 MiB
cap. WCO allocates only the size attested by the opened file handle, reads
exactly those bytes, probes one additional byte for growth, and verifies stable
identity, size, and file metadata before canonicalization. The Result Bundle is
independently verified, then only bounded, hash-bound review/spec entries are
selectively loaded. The verdict is bound to the exact Task Bundle run, Result
Bundle, manifest, spec set, published commit, Draft Pull Request, and reviewed
entry set.

Phase 7 review state is stored only below the configured state directory.
Lifecycle directories are created one component at a time and existing
symbolic-link ancestors or non-directories are rejected. Persisted receipt,
verdict, decision, and revision files are regular non-symlink files, have a
hard 2 MiB allocation cap, and must keep stable file identity, size, and
metadata across reads. Immutable artifacts use create-only exact
compare-and-adopt semantics. Receipt diagnostics are bounded so repeated
failures cannot grow persisted state without limit.

A per-round lock is owned by PID plus a random nonce. Existing locks are never
automatically stolen or removed, including apparently stale or malformed
locks, because path-based stale-lock reclamation has a replacement race.
Operator recovery is deliberately fail-closed and must verify that no live
owner exists before manual cleanup.

Every terminal decision is authorized by fresh, read-only GitHub state. The
Pull Request must still be open, unmerged, and Draft, with exact head/base
repository identities, branches, head SHA, and base SHA. Exact terminal retries
re-run this attestation rather than reusing stale approval authority. Production
GitHub access is pinned to `https://api.github.com`, has a 10-second request
timeout, and reads response bodies incrementally with a hard 1 MiB cap.
Authentication failures, transient network/service failures, and missing or
invalid repository identity are classified separately, but all fail closed.
Phase 7 never commits, pushes, marks a PR Ready, modifies a PR, or merges. An
`APPROVED` result applies only to its exact attested head; later PR/head drift
requires fresh validation before a human merge action.
