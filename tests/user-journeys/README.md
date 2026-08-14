# User-facing release gates

WCO separates deterministic product-contract checks from the real packaged installation smoke test.

`npm run test:user:contract` validates the zero-config daily-user contract: a fresh normal-user configuration has no `web_bridge` override, local ChatGPT/Codex is the effective transport, normal setup does not require infrastructure/transport credentials, advanced bridge modes are explicit only, and merge/release remains human-owned.

`npm run pack:smoke` builds the candidate, packs the actual npm tarball, installs it into a clean production-only global-style prefix and invokes the installed compiled `wco` executable. It proves the distributable package surface without relying on development dependencies.

The main GitHub CI runs both gates after unit/integration, deterministic context benchmark, E2E, build and compiled-CLI checks. The separate Advanced bridge compatibility workflow protects explicitly selected compatibility profiles without making any of them a normal-user fallback.

Protocol/authority, executor, review, Git publication, recovery, concurrency, resource-bound and security behavior remain covered by the deterministic unit/integration suites under `npm run check`.

A real local acceptance is intentionally separate from CI because hosted automation cannot prove an actual user's ChatGPT browser authorization/account session. Release qualification therefore still requires one fresh local zero-config journey through authorization, goal execution, reviewed Draft PR delivery and restart/recovery.