# Development

## Prerequisites

- Node.js 20+
- npm
- Git

Use Linux or WSL for the closest match to repository CI and the current runtime assumptions.

## Setup

```bash
npm ci
npm run build
npm run check
```

The package intentionally keeps runtime dependencies small and pins the Codex CLI/SDK versions used by the execution boundary.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev -- <args>` | run the TypeScript CLI without building |
| `npm run build` | compile TypeScript and copy runtime review resources |
| `npm run typecheck` | strict TypeScript validation |
| `npm test` | complete deterministic unit/fake suite |
| `npm run test:e2e` | full deterministic workflow integration |
| `npm run test:cli` | compiled CLI integration tests |
| `npm run test:integration` | E2E + compiled CLI tests |
| `npm run check` | repository release-candidate gate |
| `npm run pack:check` | inspect the future distributable package surface |

Native integration tests are opt-in:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

They are deliberately excluded from normal CI because a fake GitHub runner cannot prove a developer's native Codex authentication or sandbox behavior.

## Repository layout

```text
src/
  agent/           model adapters and structured output
  bundle/          Task Bundle contracts
  intake/          secure archive ingestion
  run/             prepared-run state and isolated worktrees
  execution/       implementation/review state machine
  web-authority/   registered external implementation authority
  executor/        deterministic exact-byte application
  publish/         Git publication
  pull-request/    Draft PR state machine
  result-bundle/   deterministic handoff archives
  web-review/      explicit verdict validation
  revision/        bounded same-PR revisions
  orchestration/   durable control plane and recovery
  runtime/         bounded subprocess and Codex runtime resolution

tests/             deterministic and native integration coverage
schemas/           external Web protocol schemas
templates/         Task Bundle template
examples/          operator configuration examples
docs/              architecture, protocols, development, operations
```

Some regression files retain historical identifiers in their filenames/test IDs. Those IDs are useful traceability for security regressions and are not part of the public CLI contract.

## Engineering conventions

- use `shell: false` and structured argv for spawned tools;
- set time/output/cancellation bounds before adding a subprocess path;
- keep untrusted file reads size-bounded and stable/no-follow where authority depends on them;
- keep human-readable output concise; preserve `--json` contracts for automation;
- do not make a browser/model session a durable-state dependency;
- prefer one canonical implementation for Git/GitHub/filesystem side effects and reuse it from orchestration;
- add a regression for crash windows, races, or new authority boundaries.

## Release preparation

Before a tagged release:

1. run `npm ci && npm run check && npm run pack:check` on the exact release head;
2. run native Codex/sandbox compatibility tests on supported target environments;
3. inspect the `npm pack --dry-run` file list;
4. produce checksums and build provenance for the release artifact;
5. keep release/merge publication human-approved.

A future release workflow should add SBOM/provenance generation and artifact attestation rather than relying only on a successful CI badge.
