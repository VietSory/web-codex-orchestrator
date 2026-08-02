# Security boundary

Downloaded bundles are untrusted. Phase 4 treats accepted bundles as immutable
metadata, never runs `payload/`, and never copies payload files into a target
repository. Agents cannot select repositories, models, network access,
sandbox mode, credentials, or verifier limits. Validation commands are
structured argument arrays, checked against a trusted executable/environment
policy, and run only through a sandbox adapter. Reviews and verification are
invalidated whenever the exact change-set digest changes.
