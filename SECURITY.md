# Security boundary

Downloaded bundles are untrusted. Phase 4 treats accepted bundles as immutable
metadata, never runs `payload/`, and never copies payload files into a target
repository. Agents cannot select repositories, models, network access,
sandbox mode, credentials, or verifier limits. Validation commands are
structured argument arrays, checked against a trusted executable/environment
policy, and run only through the production Codex sandbox (`codex sandbox
--permission-profile :workspace --cd <canonical-cwd> -- ...`) or a fake sandbox
in tests. The runtime is pinned to the compatible Codex CLI contract. There is no unsandboxed
fallback. The SDK receives only a minimal trusted environment; provider,
SSH, token, preload, and arbitrary process variables are excluded. Reviews
and verification are invalidated whenever the exact change-set digest changes.

The trusted runtime requires an absolute `runtime.codex_executable` whose
realpath resolves to a regular file. `runtime.codex_home`, when configured,
must also be absolute. The accepted bundle is read by the orchestrator and
bounded content is placed in prompts; it is not an additional writable SDK
root. Deterministic verifier failures are redacted and bounded before being
stored in receipts, artifacts, or Terra correction prompts.
