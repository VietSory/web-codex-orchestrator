# Packed user journeys

`npm run test:user:packed` is the reusable Linux/WSL daily-user gate. It packs the current candidate, installs the tarball with development dependencies omitted into a clean global-style prefix, creates disposable Node API, DevOps, monorepo, generic, and failure-case Git repositories plus isolated WCO homes, and invokes only the installed `wco` executable for its product-surface checks.

The gate covers clean installation, package contents, first-run setup, idempotent multi-repository registration, modern and legacy authenticated GitHub CLI credential discovery, TUI discovery and no-active-task behavior, natural-language/Web handoff, scoped DevOps and monorepo goals without deployment side effects, Web connection safety, doctor defaults, Ctrl+C recovery, scoped uninstall, repository preservation, and reinstall. It reports zero skips or fails. Set `WCO_KEEP_PACKED_USER_JOURNEY=1` only during local diagnosis to retain its disposable evidence directory.

Protocol/authority, executor, review, Git publication, recovery, concurrency, resource-bound and security cases remain exercised by the repository's deterministic unit and integration suites under `npm run check`; the packed gate complements those tests by proving the released installation surface.
