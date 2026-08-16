# Web Codex Orchestrator

**Give WCO a software-engineering goal and come back to an exact reviewed Draft PR. Only you ship it.**

Web Codex Orchestrator (WCO) is a local-first CLI that coordinates ChatGPT/Codex-assisted software work while keeping repository mutation, verification, recovery, task state, and Git lifecycle on your machine.

Normal users do **not** need to clone the WCO repository, build WCO from source, deploy a server, configure Cloudflare/ngrok, or provide an OpenAI API key.

## Quick start

The normal deterministic workflow runs on **Linux or WSL**. Native Windows and macOS are not normal execution hosts for this build because verification is isolated with Bubblewrap.

```text
Download WCO release
        ↓
Open Linux / WSL
        ↓
Install the .tgz package once
        ↓
cd into YOUR project
        ↓
wco
        ↓
Authorize ChatGPT on first use
        ↓
Give WCO a goal
        ↓
Reviewed Draft PR
        ↓
You decide whether to merge
```

If `wco setup` is invoked on an unsupported native host, WCO stops **before** setup state, ChatGPT authorization, or task state is created and tells you to move to Linux/WSL.

## 1. Requirements

Before installing WCO for the normal workflow, make sure the Linux/WSL environment has:

- **Node.js 22 or newer** and npm
- **Git**
- **Bubblewrap (`bwrap`)** for deterministic filesystem/network isolation
- a ChatGPT account for the bundled Codex authorization flow
- GitHub authentication only when Draft-PR delivery is requested

Check the basic prerequisites:

```bash
node --version
git --version
npm --version
bwrap --version
```

`node --version` must report Node.js 22 or newer.

> **Platform boundary:** downloading the artifact on Windows or macOS is fine, but this build does not start the normal setup/auth/task workflow on native Windows or macOS. Use WSL or Linux before running `wco setup` or `wco` for real tasks.

## 2. Download WCO

Open the [latest GitHub Release](https://github.com/VietSory/web-codex-orchestrator/releases/latest) and download the packaged WCO artifact.

For release `v0.3.3`, the file is:

```text
web-codex-orchestrator-0.3.3.tgz
```

A matching checksum file is also published:

```text
web-codex-orchestrator-0.3.3.tgz.sha256
```

The commands below use `v0.3.3` as the concrete **currently released** example. For a newer release, replace `0.3.3` with the version you downloaded. A development or Draft-PR candidate is not a published release merely because its code exists on GitHub.

You do **not** need GitHub's `Source code (zip)` or `Source code (tar.gz)` archives for normal use. Those are source snapshots, not the packaged WCO CLI.

### Optional: verify the checksum on Linux/WSL

From the directory containing both downloaded files:

```bash
sha256sum -c web-codex-orchestrator-0.3.3.tgz.sha256
```

A successful verification should report `OK`.

## 3. Install WCO in Linux / WSL

WCO is installed globally once inside the Linux/WSL environment so the `wco` command can be used from any project directory in that environment.

### Linux

```bash
cd ~/Downloads
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

### WSL when the browser downloaded the file on Windows

The Windows Downloads directory is usually available under `/mnt/c`:

```bash
cd /mnt/c/Users/<windows-user>/Downloads
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

> **WSL/Linux path reminder:** use `./file.tgz`, not `.\file.tgz`.
>
> In Bash, `.\web-codex-orchestrator-0.3.3.tgz` is interpreted incorrectly and npm may try to open a file named `.web-codex-orchestrator-0.3.3.tgz`, producing an `ENOENT` error.

Do not switch to PowerShell to run the normal WCO task workflow. Open the project from WSL instead; WCO intentionally fails early on native Windows so a successful package install cannot be mistaken for supported deterministic execution.

### Normal users do not clone WCO

This is **not** required for normal use:

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run build
```

That is the contributor/developer workflow, not the end-user installation flow.

## 4. Run WCO inside your project

After WCO is installed, move into the repository that you actually want WCO to work on **from Linux/WSL**.

### WSL example

```bash
cd /mnt/d/Coding/my-project
wco
```

### Linux example

```bash
cd ~/code/my-project
wco
```

Do not run WCO from the Downloads directory unless the Downloads directory itself is intentionally the project you want WCO to operate on.

## 5. First authorization

On the first interactive use, WCO delegates authorization to its **bundled official Codex runtime**.

The normal flow is:

```text
wco
 ↓
platform/repository setup checks
 ↓
Codex official ChatGPT sign-in (first use only, when needed)
 ↓
Browser authorization
 ↓
Return to the terminal
 ↓
WCO is ready
```

Unsupported native hosts stop before the authorization step. A readiness failure before task ownership leaves task state uncreated or saved progress unchanged.

WCO does not ask a normal user to copy or enter:

- an OpenAI API key
- ChatGPT cookies
- a tunnel ID or runtime key
- a Cloudflare/ngrok endpoint
- a relay secret
- an MCP connector
- a custom domain

If the ChatGPT session later expires or is revoked, reconnect from the shell with:

```bash
wco web connect
```

Or, from inside the interactive WCO session, use:

```text
/auth connect
```

## 6. Give WCO a goal

Once the interactive CLI is open, PAIR is the normal default mode.

You can start a PAIR task explicitly:

```text
/new Add rate limiting to login and add regression tests
```

Or start AUTOPILOT:

```text
/auto Add rate limiting to login and add regression tests
```

### PAIR vs AUTOPILOT

| Mode | Start | Use it when |
| --- | --- | --- |
| **PAIR** | plain goal or `/new <goal>` | You want to collaborate while WCO is still understanding the task. You can type extra details until the plan locks; WCO pauses the same background owner safely, adds the clarification, and continues the same task. |
| **AUTOPILOT** | `/auto <goal>` | The goal is already clear and you want WCO to continue end-to-end unless a real decision needs you. |

Both modes preserve local mutation authority, deterministic verification, recovery, and the human-only merge/release boundary.

Neither mode automatically merges or releases your code.

While a local task is running, the interactive prompt remains available for safe read/control commands such as `/status`, `/review`, and `/pause`. The slash palette becomes context-aware and shows only commands that are valid while the background worker owns mutation. Runtime guards still enforce the same single-owner rule even if an unavailable command is typed manually. Status and review output explicitly show **Your action**. If WCO owns the next step, the action is `None — WCO ...`; if WCO needs a decision or the final merge, it tells you exactly what to do.

## What WCO does with a goal

```text
YOUR PROJECT
    │
    ▼
 user goal
    │
    ▼
 semantic author (read-only)
    │
    ▼
 bounded exact repository reads
    │
    ▼
 sealed contract
    │
    ▼
 canonical prepared run
    │
    ▼
 Codex implementation proposal
    │
    ▼
 WCO validation + isolated mutation
    │
    ▼
 deterministic verification / repair
    │
    ▼
 independent semantic final review
    │
    ▼
 exact reviewed Draft PR
    │
    ▼
 YOU decide whether to merge/release
```

Provider/model output is never direct repository or shipment authority. WCO validates closed schemas plus exact job/run/path/digest bindings before workflow authority can advance.

The normal production path does **not** run the blind Web-B semantic benchmark/shadow challenger on every task. That evaluation remains explicitly invokable for maintainer measurement so normal users do not spend extra provider turns or tokens on non-authoritative research instrumentation.

## Daily use

After installation and the first successful ChatGPT authorization, the normal returning-user flow is intentionally small:

```bash
cd /path/to/project
wco
```

Then give WCO a goal. If you already have an unfinished current task, use `/continue` to continue that exact task. If there is no current task, or the current task is already complete, `/continue` does not change focus: type a new follow-up goal, or use `/resume` when you intentionally want to choose a different saved task. `/resume` always opens saved-task selection when no number is supplied; `/resume <number>` selects the matching `/history` item after durable re-attestation.

WCO does not trust history display data as workflow authority. Before a historical task becomes current again, WCO re-attests its canonical run receipt, exact durable run ledger, repository/base binding, and bounded WCO-owned task/implementation artifacts. Completed tasks stay completed and should receive a new follow-up goal instead of reopening old authority. Authoring-only, stale, corrupt, mismatched, redirected, or symlinked history stays reference-only.

A blocked current task is still the current task: `/continue` will not silently jump to some older history item. Use `/status`, `/review`, and `/doctor` to resolve the blocker, or use `/resume` explicitly if you intentionally want to switch saved tasks. Switching away from any unfinished current task asks for confirmation first. That confirmation is bound to the exact current session; if another WCO terminal changes focus while you are answering, the switch/replacement is rejected rather than applying your confirmation to a different task.

Before a local task starts or resumes, WCO uses its existing mode-aware readiness checks so required local prerequisites are caught before normal task execution begins.

You should not need to reinstall WCO, reconfigure a relay, or perform browser interaction for every task.

## Commands

Inside the interactive WCO CLI, the normal command-discovery surface is intentionally small:

```text
/new <goal>             start a collaborative PAIR task
/auto <goal>            start an end-to-end AUTOPILOT task
/continue               continue only the current unfinished saved task
/resume                  choose a saved task to resume
/resume <number>         resume one history item after durable re-attestation
/status                  show current progress and Your action
/task                    show current goal and plan state
/auth status             show ChatGPT authorization status
/auth connect            authorize or re-authorize ChatGPT
/review                  show verification/review/Draft-PR evidence
/pause                   pause before the next safe step
/history                 show recent task history
/history <number>        inspect one history item read-only
/doctor                  check readiness for the current mode
/uninstall               remove WCO-owned local resources
/help                    show normal workflow commands
/quit                    exit safely
```

`/run` remains accepted as a compatibility alias for continuation, but normal users are taught `/continue`.

Starting `/new` or `/auto` while an unfinished task is still in current focus asks for confirmation first. The previous durable history is preserved. `/history` is inspection only; `/resume` is the separate explicit focus-changing action and is allowed only after WCO re-attests durable authority.

The interactive composer follows familiar terminal semantics:

```text
Ctrl+C              with text: clear current input; with an empty input: request a safe task interrupt and keep WCO open
Ctrl+D              with empty input: request a safe exit; with text before the cursor: delete the next character
Ctrl+J              insert a newline
Shift+Enter         insert a newline when the terminal reports the modified Enter key
Up/Down, Ctrl+P/N   browse bounded prompt history for this WCO session
Ctrl+R              search backward through bounded prompt history
Ctrl+L              redraw the current composer
```

Pasted multiline goals and clarifications keep their line breaks instead of being flattened into one line. Background progress may redraw around the composer, but it does not take stdin ownership away from the user.

Advanced/compatibility commands remain accepted for power users and existing integrations but are intentionally hidden from the normal slash palette. The existing shell compatibility surface is unchanged, including:

```text
wco web status
wco web connect
wco web connect --native
wco web connect --managed
wco web setup --personal
wco web connect --self-hosted
```

WCO never silently falls back from the normal local path to an advanced compatibility profile.

## Troubleshooting

### `ENOENT ... .web-codex-orchestrator-0.3.3.tgz`

If WSL/Linux reports something similar to:

```text
ENOENT: no such file or directory, open '.../.web-codex-orchestrator-0.3.3.tgz'
```

check whether you used this PowerShell-style path by mistake:

```text
.\web-codex-orchestrator-0.3.3.tgz
```

In WSL/Linux use:

```bash
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

You can confirm that the package is present with:

```bash
ls -l web-codex-orchestrator-0.3.3.tgz
```

### Native Windows/macOS says the normal workflow requires Linux/WSL

That is an intentional fail-early boundary, not a partial setup failure. Open the project in WSL/Linux and run `wco` there. WCO stops before creating setup/auth/task state on the unsupported native host.

### `wco: command not found`

First confirm that installation completed successfully inside the same Linux/WSL environment:

```bash
npm list -g --depth=0
command -v wco
npm prefix -g
```

If npm's global install directory is not on your shell `PATH`, fix the Node/npm installation or PATH configuration before continuing.

### Unsupported Node.js version

Check:

```bash
node --version
```

WCO requires Node.js 22 or newer.

### ChatGPT authorization expired

From the shell, run:

```bash
wco web connect
```

Or inside WCO:

```text
/auth connect
```

This repeats the same official sign-in flow. WCO does not switch to an API-key or hosted-relay fallback.

### Not sure whether WCO is ready

Inside WCO, use:

```text
/doctor
/auth status
/status
```

## Local-first design

A fresh normal-user configuration intentionally has **no `web_bridge` field**. Its absence selects the zero-config local ChatGPT/Codex transport.

WCO keeps WCO-owned engineering authority and state on the user's machine, including:

- repository and isolated worktree state
- task/session state and receipts
- repository-context cache/read coverage
- Task Bundles and Result Bundles
- mutation authority
- deterministic verifier/sandbox state
- Git/Draft-PR recovery state

The bundled Codex runtime communicates outbound using the user's ChatGPT authorization. WCO does not require a normal-path hosted WCO control plane.

For the normal single-user path:

```text
WCO-hosted services                 = 0
third-party relay/cloud setup       = 0
public localhost/inbound ports      = 0
API/tunnel/relay keys entered       = 0
MCP/App/Workspace Agent setup       = 0
copied browser credentials          = 0
per-task browser interactions       = 0
per-task authorization/config       = 0
automatic merge/release             = 0
```

## Context and token efficiency

WCO progressively narrows repository context instead of treating the entire repository as model authority:

```text
goal
→ summary / tree / search
→ focused exact file or region reads
→ digest reuse / content-addressed cache
→ contract
→ implementation and result deltas
```

The full authoring protocol/schema tutorial is sent on the initial semantic-author turn. Repository-result follow-ups stay on the same semantic thread and send the exact result plus a compact identity/safety reminder instead of retransmitting the full tutorial on every read. Local validators still parse the complete closed schema before any provider output can become authority.

Disposable caches or indexes may improve localization, but authoritative repository content resolves back to exact reads and digests before mutation. Prompt/context benchmarks enforce bounded deterministic footprint; provider token usage is measured durably and bounded by trusted configuration.

The explicit maintainer benchmark for blind semantic challenger effectiveness remains:

```bash
npm run benchmark:semantic:provider
```

It is not part of normal per-task provider consumption.

## For contributors: install from source

If you want to modify WCO itself, then clone the repository:

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run check
```

Useful development commands include:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:user:contract
npm run pack:check
npm run pack:smoke
```

This source workflow is intentionally separate from normal end-user installation.

## Release boundary

Publishing WCO remains a human maintainer action. WCO must never merge this project, mark a PR ready, tag, deploy, release, or publish a package without an explicit maintainer decision.

Before release:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:contract
```

A release is not normal-user ready until the exact packaged zero-config journey passes and a real local acceptance confirms first authorization, complete goal-to-Draft-PR execution, final review, and restart/recovery behavior.

## More documentation

- [Frozen user experience contract](docs/user-experience-contract.md)
- [Architecture](docs/architecture.md)
- [Web bridge](docs/web-bridge.md)
- [ADR 0004 — local ChatGPT/Codex default](docs/adr/0004-chatgpt-codex-local-default.md)
- [Job modes](docs/job-modes.md)
- [Operations](docs/operations.md)
- [Security policy](SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE).