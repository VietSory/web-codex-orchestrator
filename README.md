# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

Web Codex Orchestrator (WCO) is a security-focused CLI that turns externally authored implementation evidence into a durable, reviewable Git workflow. It validates untrusted handoffs, operates in isolated worktrees, runs deterministic verification and independent model review, publishes only exact approved changes, opens a Draft pull request, and keeps merge authority with a human.

> Status: pre-release. The repository is suitable for development and technical evaluation; a stable binary/package release has not been published yet.

## What WCO does

```text
Task Bundle
    ↓
secure intake + isolated worktree
    ↓
registered Web implementation authority
    ↓
deterministic apply + verification
    ↓
Terra review → Sol review
    ↓
exact Git publication → Draft PR
    ↓
Result Bundle → explicit Web verdict
    ↓
bounded same-PR revision loop
    ↓
human merge decision
```

WCO deliberately does not treat browser tabs, chat transcripts, model sessions, or a previous success message as lifecycle authority. Durable receipts and exact content identities drive recovery and continuation.

## Requirements

- Node.js 22 or newer
- Git
- a local repository registered in WCO configuration
- Codex authentication for model-backed execution/review paths
- GitHub credentials only for operations that attest or create a Draft pull request

Linux and WSL are the primary development environments today. Native platform behavior that depends on local Codex/browser tooling should be validated on the target machine before release use.

## Quick start from source

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run build
npm link
wco --help
```

`npm link` is optional. Without it, use `npm run wco -- <command>` from the checkout.

Create a local configuration without adding it to Git:

```bash
mkdir -p .wco
cp examples/config.example.json .wco/config.json
```

Edit `.wco/config.json` so repository paths, remotes, credentials, model policy, and limits match your environment. Then set explicit CLI defaults:

```bash
export WCO_CONFIG="$PWD/.wco/config.json"
export WCO_STATE_DIR="$PWD/.wco/state"
```

Run the preflight:

```bash
wco doctor
```

Once a run exists, set its identity once:

```bash
export WCO_RUN_ID='<task-id>:<task-bundle-sha256>'
wco status
wco next
wco continue
```

Flags always override the need for environment defaults, so automation can remain fully explicit.

## Common commands

```text
wco doctor       machine/config/runtime preflight
wco status       durable run status
wco next         next durable transition, read-only
wco continue     advance the workflow within bounded transition limits
wco pause        prevent new transitions
wco resume       resume an explicitly paused run
wco validate     validate a Task Bundle directory
wco intake       securely ingest a Task Bundle archive
wco scan/watch   process an inbox of Task Bundles
```

Use `--json` where supported for machine-readable output. Human output stays concise and diagnostic rather than acting as durable state.

## Development

```bash
npm run check
```

`check` runs template validation, strict TypeScript checking, the complete deterministic test suite, end-to-end workflow coverage, the build, and compiled CLI integration tests.

Native opt-in checks are separate because CI must not pretend to prove a developer's local Codex or sandbox environment:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

See [Development](docs/development.md) for repository structure and test policy.

## Architecture and security

WCO follows fail-safe authority rules, end-to-end re-attestation, least privilege, bounded resources, content-addressed evidence, and recovery from durable receipts instead of transcript replay.

- [Architecture](docs/architecture.md)
- [Protocols and authority](docs/protocols.md)
- [Operations and packaging](docs/operations.md)
- [Security policy](SECURITY.md)

## Packaging strategy

Native CLI installation is the primary target. WCO needs tight access to host Git worktrees, local Codex authentication, credentials, and optional browser/bridge tooling, so a Docker image is not the default runtime boundary today. A container can still be useful later for reproducible development and deterministic CI.

The repository already verifies its future distributable surface with `npm pack --dry-run`. The intended release sequence is GitHub release artifacts first, then optional npm publication after native compatibility checks are stable. See [Operations](docs/operations.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
