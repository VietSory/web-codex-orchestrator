# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Spend Codex on implementation. Use ChatGPT Web to architect the task. Verify the exact result before it reaches you.**

Web Codex Orchestrator (WCO) is a local CLI for medium and large AI-assisted coding jobs. Start it inside a Git repository, type a goal, and let WCO coordinate bounded repository inspection, a sealed implementation contract, Codex execution, deterministic checks, independent Terra/Sol review, and GitHub Draft PR delivery.

The public release is resolved from GitHub's **Latest** release. The package is distributed as a checksummed GitHub release tarball and remains private on npm.

## Install the Latest release

Requirements:

- Linux or WSL;
- Node.js 22 or newer and npm;
- Git;
- Codex authentication for implementation/review;
- GitHub CLI authentication for Draft PR delivery;
- a browser for the one-time managed ChatGPT Web authorization.

Resolve, download, and verify the current Latest release artifact:

```bash
release_tag="$(gh release view --repo VietSory/web-codex-orchestrator --json tagName --jq '.tagName')"
release_version="${release_tag#v}"
release_asset="web-codex-orchestrator-${release_version}.tgz"
gh release download "$release_tag" --repo VietSory/web-codex-orchestrator --pattern "${release_asset}*"
sha256sum -c "${release_asset}.sha256"
npm install --global "./${release_asset}"
test "$(wco --version)" = "$release_version"
```

The final command must exit successfully, proving the installed binary reports the version selected by GitHub Latest. Installing Latest also repairs incomplete older installations.

## Daily use

```bash
cd /path/to/project
wco
```

On the first run, WCO confirms setup, detects the repository, checks Codex/GitHub/relay readiness, and enters the interactive shell.

### PAIR — default

Type a normal-language goal:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

Plain goals and `/new <goal>` remain PAIR. ChatGPT Web inspects the repository, seals the architecture/acceptance contract, and supplies exact Web implementation authority. WCO validates that authority, executes the bounded workflow, verifies the exact result, performs Terra/Sol review, publishes only an approved digest, opens a Draft PR, and returns the result to Web for final review.

PAIR never silently becomes autonomous.

### AUTOPILOT — explicit

Use one command:

```text
/auto Fix the authentication race condition and add regression tests.
```

The user does **not** create a Task Bundle, copy a run ID, set a state directory, move ZIPs, or invoke an internal Node entry point.

For AUTOPILOT, ChatGPT Web inspects the exact repository and seals the architecture/acceptance contract, then stops authoring. From that prepared contract WCO owns the bounded job:

```text
Web contract
→ Codex/Terra implementation
→ deterministic verification
→ Terra review
→ Sol review
→ repair/re-review when required
→ exact Git publication
→ Draft PR
→ Result Bundle
→ Web final review
→ bounded revision loop when required
→ READY FOR YOU
```

`READY FOR YOU` always stops at the human merge boundary. `NEEDS YOU` is reserved for consequential ambiguity, policy blocks, exhausted bounded resources, Web escalation, or a non-retryable operational failure.

If the terminal closes or the machine restarts, run `wco` in the same repository and use `/run`. AUTOPILOT resumes from durable receipts instead of relying on browser/model history. Ctrl+C during an AUTOPILOT drive requests a safe `PAUSED` checkpoint.

## Managed Web setup

WCO opens the preconfigured WCO Senior Architect GPT. ChatGPT may ask the user to Connect/authorize WCO once. The user does not configure a Custom GPT, import YAML, enter relay/GPT URLs, copy a bearer token, run a tunnel, or edit WCO JSON. WCO stores only a scoped, expiring device credential in protected WCO-owned credential storage.

Maintainers deploy and configure the stable managed relay, GPT Action schema, GPT and OAuth once globally. Advanced self-hosting remains available only through `/web connect --self-hosted` and is not the normal workflow.

After the one-time Web setup, returning PAIR is simply `wco` then a goal; AUTOPILOT is `wco` then `/auto <goal>`. Completed local task focus becomes terminal, so an old sealed task no longer blocks the next normal goal.

## What the Web handoff does

WCO creates a pending authoring job and opens the configured WCO Senior Architect GPT. The hosted ChatGPT UI may require one click to start the pending job. The GPT can request bounded searches and exact-base file reads through the authenticated relay, but repository text is data—not authority.

The pending request carries the explicit orchestration mode. Missing mode is treated as PAIR only for backward compatibility. In PAIR the GPT may submit the exact implementation authority after sealing the contract. In AUTOPILOT the GPT must stop after `contract_sealed`; Codex/ExecutionService owns implementation and repair.

When the exact Draft PR result is ready, WCO opens the GPT for final review. APPROVE stops at the human merge boundary; REVISE uses the bounded same-PR revision loop; ESCALATE stops for a human. WCO never merges or marks a PR ready.

The relay's pending surfaces choose the newest non-expired authoring/final-review job and reject invalid orchestration modes instead of trusting transport input.

## Discoverable commands

At the WCO prompt, enter `/` or `/help`:

```text
/new <goal>       start a new PAIR task
/auto <goal>      start an AUTOPILOT task
/status           show current progress
/task             show the current goal and contract state
/run              continue the active PAIR/AUTOPILOT workflow
/web status       diagnose the Web connection
/web connect      connect the managed Senior Architect once
/web open         open the fixed Senior Architect GPT
/web disconnect   revoke/remove the local device credential
/review           show Terra/Sol/result/Draft PR evidence
/pause            stop before the next safe transition
/resume           clear an explicit pause
/history          show bounded history for this repository
/config           show user-facing settings
/config web       reconnect the managed Web connection
/doctor           check runtime, authentication and sandbox readiness
/uninstall        remove WCO-owned local resources
/unitsall         alias for /uninstall
/quit             exit safely
```

Plain text before contract sealing is treated as clarification. Plain text after sealing is rejected with guidance to use `/new`, so sealed authority cannot silently change. Once a task is terminal-complete, a fresh plain goal starts a new PAIR task normally.

## Recovery

If the terminal closes or the machine restarts, return to the same repository and run `wco`. WCO discovers repository-scoped durable state and re-attests completed work. Use `/status`, `/review`, `/doctor`, `/web status`, and `/run` rather than copying internal identities.

WCO preserves uncommitted work in the original repository and performs implementation in a managed isolated worktree. If state or an external side effect cannot be proven, WCO stops and reports the next safe action.

AUTOPILOT additionally re-attests a cached `READY_FOR_YOU` against the current Draft PR head before returning the merge prompt, so a moved/closed/non-draft/wrong-base PR cannot inherit stale Web approval.

## Safety boundary

WCO preserves exact repository/base binding, bounded archive/path policy, network-disabled verification, exact Terra/Sol change-set binding, exact remote/Draft PR binding, fresh merge-readiness attestation, credential redaction, durable recovery, and the human merge boundary. WCO never direct-pushes protected branches, force-pushes, enables auto-merge, marks ready, deploys, or publishes a release automatically.

See [SECURITY.md](SECURITY.md) and [Protocols](docs/protocols.md) for detailed contracts.

## Advanced automation and compatibility

The packed CLI still exposes Task Bundle, Web implementation pack, verdict, run-ID and explicit state/config commands for deterministic automation and backward compatibility. They are not required for normal interactive use.

The standalone AUTOPILOT driver remains available for operators who already have a prepared run, but normal users use `/auto <goal>` inside `wco`.

Run `wco --help` for the low-level surface. Operators should read [Operations](docs/operations.md), [Architecture](docs/architecture.md), [Job modes](docs/job-modes.md), and [Protocols](docs/protocols.md).

## Development

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Real native gates may consume provider usage:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

Normal CI uses fake agents and synthetic relay actors; it does not contact model providers or ChatGPT Web.

## Hosted-service deployment boundary

The repository contains the managed client, OAuth/device-flow contracts, reference relay behavior, GPT instructions and fail-closed managed metadata. A real stable managed relay/OAuth deployment and a configured hosted Senior Architect GPT are external deployment operations and must be verified separately before claiming the hosted managed path is live. WCO must never replace that gate with invented URLs or synthetic “production” evidence.

## License

Apache License 2.0. See [LICENSE](LICENSE).
