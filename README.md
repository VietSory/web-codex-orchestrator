# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Spend Codex on implementation. Use ChatGPT Web to architect the task. Verify the exact result before it reaches you.**

Web Codex Orchestrator (WCO) is a local CLI for medium and large AI-assisted coding jobs. Start it inside a Git repository, type a goal, and let WCO coordinate bounded repository inspection, a sealed implementation contract, Codex execution, deterministic checks, **one selected independent model review**, and GitHub Draft PR delivery.

The default reviewer is **Sol with high reasoning effort**. Use `/mode` to select Sol or Terra and the reasoning effort for new tasks. WCO never stacks both reviewers in the normal product flow.

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

On the first run, WCO:

1. confirms setup;
2. detects the repository root, remote, base branch and project tools;
3. writes WCO-owned configuration/state under the user data directory;
4. reports Codex and GitHub credential readiness;
5. checks the managed WCO Relay and offers one-time ChatGPT Web authorization;
6. enters the interactive shell.

Then type a normal-language goal, for example:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

Plain goals and `/new <goal>` keep the existing **PAIR** workflow. To explicitly hand the bounded job to WCO after Web seals the architecture/acceptance contract, use **AUTOPILOT**:

```text
/auto Fix the authentication race condition and add regression tests.
```

Normal review policy is deliberately simple:

```text
Default: Sol · high
```

Inspect or change the reviewer preference for new tasks:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

Supported reasoning efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`. The selected reviewer is snapshotted when a task starts and frozen to the prepared run, so changing `/mode` later cannot silently switch an in-progress or resumed task.

AUTOPILOT is a normal `wco` command. The user does not create a Task Bundle, move a ZIP, copy a run ID, set a state directory, or invoke an internal Node entry point. Web inspects the exact repository and seals the contract; Codex/ExecutionService owns implementation and bounded repair; deterministic verification runs; then **exactly one selected reviewer** reviews the verified change. A `REVISE` in AUTOPILOT returns to the implementer, re-runs verification, and returns to the same selected reviewer. `APPROVE` proceeds to exact publication, Draft PR creation and Result Bundle attestation.

WCO opens the preconfigured WCO Senior Architect GPT. ChatGPT may ask the user to Connect/authorize WCO once. The user does not configure a Custom GPT, import YAML, enter relay/GPT URLs, copy a bearer token, run a tunnel, or edit WCO JSON. WCO stores only a scoped, expiring device credential in protected WCO-owned credential storage.

Maintainers deploy and configure the stable managed relay, GPT Action schema, GPT and OAuth once globally. Advanced self-hosting remains available only through `/web connect --self-hosted` and is not the normal workflow.

After the one-time Web setup, the returning-user PAIR path is simply:

```text
cd project
wco
type one goal
```

For AUTOPILOT, the returning-user path is `wco` then `/auto <goal>`.

No Task Bundle creation, ZIP movement, checksum calculation, JSON editing, state-directory environment variable, or run-ID copying is required on either normal interactive path.

## Normal user flows

PAIR keeps Web's exact implementation authority:

```text
user goal
→ Web inspects exact repository/base
→ Web seals architecture + exact implementation authority
→ WCO applies the exact authorized change
→ deterministic verification
→ selected reviewer (default Sol/high)
→ publish exact branch
→ open Draft PR
→ bind Result Bundle to exact published/Draft-PR head
→ READY FOR YOU
→ human reviews/merges
```

AUTOPILOT gives implementation/repair ownership to WCO after the Web contract handoff:

```text
user /auto goal
→ Web inspects exact repository/base and seals the contract
→ Codex/Terra implementer
→ deterministic verification
→ selected reviewer (default Sol/high)
   ├─ REVISE → implementer repair → verify again → same reviewer
   ├─ REPLAN / policy / consequential ambiguity → NEEDS YOU
   └─ APPROVE
→ publish exact branch
→ open Draft PR
→ bind Result Bundle to exact published/Draft-PR head
→ READY FOR YOU
→ human reviews/merges
```

There is **one reviewer per normal task**. Selecting Sol does not add Terra review. Selecting Terra does not add Sol review. ChatGPT Web is the architect/handoff authority, not a second automatic final-review layer.

## What the Web handoff does

WCO creates a pending authoring job and opens the configured WCO Senior Architect GPT. The hosted ChatGPT UI may require one click to start the pending job. The GPT can request bounded searches and exact-base file reads through the authenticated relay, but repository text is data—not authority.

The pending request carries the explicit orchestration mode. Missing mode is treated as PAIR only for backward compatibility. In PAIR, Web may submit exact implementation authority after sealing the contract. In AUTOPILOT, Web is architecture/specification authority during authoring and stops after `contract_sealed`; Codex/ExecutionService owns implementation and bounded repair after that handoff.

WCO locally validates and materializes the sealed contract and, for PAIR, implementation authority. The relay cannot authorize code, weaken path policy, publish, merge, or replace WCO receipts. Normal AUTOPILOT authoring becomes terminal at contract seal, so Web cannot submit implementation authority afterward.

The previous Web final-review / Phase 8 same-PR revision machinery remains available only as an explicit low-level compatibility path. It is not part of the normal PAIR or `/auto` flow and is not an additional reviewer layer.

## Discoverable commands

At the WCO prompt, enter `/` or `/help`:

```text
/new <goal>       start a different PAIR task
/auto <goal>      start an AUTOPILOT task
/mode             show the reviewer for new tasks
/mode <model> <effort>  choose Sol/Terra + effort for new tasks
/status           show current progress
/task             show the current goal and contract state
/run              continue the active workflow
/web status       diagnose the Web connection
/web connect      connect the managed Senior Architect once
/web open         open the fixed Senior Architect GPT
/web disconnect   revoke/remove the local device credential
/review           show selected-review/result/Draft PR evidence
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

Plain text before contract sealing is treated as clarification. Plain text after sealing is rejected with guidance to use `/new`, so sealed authority cannot silently change. Once a task reaches the terminal local `COMPLETED` marker, it no longer blocks the next normal goal; that UI marker is not merge authority.

## Recovery

If the terminal closes or the machine restarts, return to the same repository and run:

```bash
wco
```

WCO discovers repository-scoped durable state and re-attests completed work. It does not blindly replay an ambiguous model call, push, or PR creation. Use `/status` for progress, `/doctor` for local prerequisites, `/web status` for relay problems, `/run` to continue the active PAIR/AUTOPILOT workflow, and `/resume` only when you explicitly paused the run.

AUTOPILOT resumes from its durable prepared run without exposing internal identities. Its selected reviewer/model/effort is frozen per run. A cached normal-path `READY_FOR_YOU` re-attests the exact Result Bundle and current open Draft PR binding before WCO returns the merge action. Ctrl+C during an interactive AUTOPILOT drive requests a resumable safe pause rather than weakening authority.

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
- exact change-set binding for deterministic verification and the selected reviewer;
- one selected reviewer per normal task, frozen to the run;
- remote URL and Draft PR repo/base/head verification;
- no direct protected-branch push, force push, auto-merge, Mark Ready or branch deletion;
- credential redaction and durable receipts;
- fail-closed recovery around ambiguous model and external side effects.

Both PAIR and AUTOPILOT stop at the human merge boundary. Neither mode automatically merges, marks a PR ready, enables auto-merge, deploys, publishes a release, or performs destructive Git updates.

See [SECURITY.md](SECURITY.md) and [Protocols](docs/protocols.md) for the detailed contracts.

## Advanced automation and compatibility

The packed CLI still exposes Task Bundle, Web implementation pack, verdict, run-ID and explicit state/config commands for deterministic automation and backward compatibility. They are not required for normal interactive use.

The lower-level `dist/orchestration/autopilot-standalone-cli.js` remains available for operators who already have a prepared run; normal users use `/auto <goal>` inside `wco`.

Legacy Web-final-review/revision services remain available for existing low-level automation, but normal product execution terminates after the selected reviewer, exact publication, Draft PR and Result Bundle attestation.

Run `wco --help` for that low-level surface. Operators building automation should read [Operations](docs/operations.md), [Architecture](docs/architecture.md), [Job modes](docs/job-modes.md), and [Protocols](docs/protocols.md) before using it.

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

## Hosted-service deployment boundary

The repository contains the managed client, OAuth/device-flow contracts, reference relay behavior, GPT instructions and fail-closed managed metadata. A real stable managed relay/OAuth deployment and configured hosted Senior Architect GPT are external deployment operations and must be verified separately before claiming the managed hosted path is live. Synthetic CI is not proof of that external deployment.

## License

Apache License 2.0. See [LICENSE](LICENSE).
