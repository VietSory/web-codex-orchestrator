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
- an HTTPS WCO Action relay and configured WCO Senior Architect GPT for the hosted Web handoff.

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

On the first run, WCO:

1. confirms setup;
2. detects the repository root, remote, base branch and project tools;
3. writes WCO-owned configuration/state under the user data directory;
4. reports Codex and GitHub credential readiness;
5. enters the interactive shell.

Then type a normal-language goal, for example:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

The first task offers to connect the Web Architect if it is not configured. Connection setup verifies the relay before saving anything. The bearer token is stored only in WCO-owned credentials and is hidden during terminal input.

After the one-time Web setup, the returning-user path is simply:

```text
cd project
wco
type one goal
```

No Task Bundle creation, ZIP movement, checksum calculation, JSON editing, state-directory environment variable, or run-ID copying is required on this path.

## What the Web handoff does

WCO creates a pending authoring job and opens the configured WCO Senior Architect GPT. The hosted ChatGPT UI may require one click to start the pending job. The GPT can request bounded searches and exact-base file reads through the authenticated relay, but repository text is data—not authority.

WCO locally validates and materializes the sealed contract and implementation. The relay cannot authorize code, weaken path policy, publish, merge, or replace WCO receipts.

When the exact Draft PR result is ready, WCO opens the GPT for final review. APPROVE stops at the human merge boundary; REVISE uses the bounded same-PR revision loop; ESCALATE stops for a human. WCO never merges or marks a PR ready.

## Discoverable commands

At the WCO prompt, enter `/` or `/help`:

```text
/new <goal>       start a different task
/status           show current progress
/task             show the current goal and contract state
/run              continue the active workflow
/web status       diagnose the Web connection
/web connect      verify and save a Web connection
/web open         open the configured Senior Architect GPT
/web disconnect   remove the local relay credential
/review           show Terra/Sol/result/Draft PR evidence
/pause            stop before the next safe transition
/resume           clear an explicit pause
/history          show bounded history for this repository
/config           show user-facing settings
/config web       configure the Web connection
/doctor           check runtime, authentication and sandbox readiness
/uninstall        remove WCO-owned local resources
/unitsall         alias for /uninstall
/quit             exit safely
```

Plain text before contract sealing is treated as clarification. Plain text after sealing is rejected with guidance to use `/new`, so sealed authority cannot silently change.

## Recovery

If the terminal closes or the machine restarts, return to the same repository and run:

```bash
wco
```

WCO discovers repository-scoped durable state and re-attests completed work. It does not blindly replay an ambiguous model call, push, or PR creation. Use `/status` for progress, `/doctor` for local prerequisites, `/web status` for relay problems, and `/resume` only when you explicitly paused the run.

WCO preserves uncommitted work in the original repository and performs implementation in a managed isolated worktree. If state or an external side effect cannot be proven, WCO stops and reports the failed subsystem, what remained unchanged, and the next safe action.

## Uninstall and reinstall

Inside WCO, run `/uninstall` (or `/unitsall`) and confirm. From a non-interactive shell, preview and confirm with:

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO removes only its canonical owned home and clean, re-attested managed worktrees. It preserves source repositories, uncommitted work, Git history, remote branches, Draft PRs and deployments. A packed npm installation schedules removal from its exact detected npm prefix after WCO exits.

Reinstall the checksummed release tarball to start again.

## Safety boundary

WCO preserves these invariants throughout the interactive and automation paths:

- exact repository and base-commit binding;
- secure bounded archive intake;
- allowed/forbidden path and preimage enforcement;
- network-disabled verification sandbox with no unrestricted fallback;
- exact change-set binding for Terra and Sol review;
- remote URL and Draft PR repo/base/head verification;
- no direct protected-branch push, force push, auto-merge, Mark Ready or branch deletion;
- credential redaction and durable receipts;
- fail-closed recovery around ambiguous model and external side effects.

See [SECURITY.md](SECURITY.md) and [Protocols](docs/protocols.md) for the detailed contracts.

## Advanced automation and compatibility

The packed CLI still exposes Task Bundle, Web implementation pack, verdict, run-ID and explicit state/config commands for deterministic automation and backward compatibility. They are not required for normal interactive use.

Run `wco --help` for that low-level surface. Operators building automation should read [Operations](docs/operations.md), [Architecture](docs/architecture.md), and [Protocols](docs/protocols.md) before using it.

## Development

To work on WCO itself:

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Real native gates are explicit and may consume provider usage:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

Normal CI uses fake agents and synthetic relay actors; it does not contact model providers or ChatGPT Web.

## License

Apache License 2.0. See [LICENSE](LICENSE).
