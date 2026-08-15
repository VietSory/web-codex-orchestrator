# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Give WCO a software-engineering goal and come back to an exact reviewed Draft PR. Only you ship it.**

Web Codex Orchestrator (WCO) is a local-first CLI that coordinates ChatGPT/Codex-assisted software work while keeping repository mutation, verification, recovery, task state, and Git lifecycle on your machine.

Normal users do **not** need to clone the WCO repository, build WCO from source, deploy a server, configure Cloudflare/ngrok, or provide an OpenAI API key.

## Quick start

The normal flow is:

```text
Download WCO release
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

## 1. Requirements

Before installing WCO, make sure the machine has:

- **Node.js 22 or newer** and npm
- **Git**
- platform sandbox prerequisites required by the selected execution mode
- a ChatGPT account for the bundled Codex authorization flow
- GitHub authentication only when Draft-PR delivery is requested

Check the basic prerequisites:

```bash
node --version
git --version
npm --version
```

`node --version` must report Node.js 22 or newer.

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

The commands below use `v0.3.3` as the concrete example. For a newer release, replace `0.3.3` with the version you downloaded.

You do **not** need GitHub's `Source code (zip)` or `Source code (tar.gz)` archives for normal use. Those are source snapshots, not the packaged WCO CLI.

### Optional: verify the checksum on Linux/WSL

From the directory containing both downloaded files:

```bash
sha256sum -c web-codex-orchestrator-0.3.3.tgz.sha256
```

A successful verification should report `OK`.

## 3. Install WCO

WCO is installed globally once so the `wco` command can be used from any project directory.

### WSL / Linux / macOS

Go to the directory containing the downloaded `.tgz` file and install it with a Unix-style relative path:

```bash
cd ~/Downloads
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

If the file was downloaded by Windows and you are using WSL, the Downloads directory will usually be under `/mnt/c`:

```bash
cd /mnt/c/Users/<windows-user>/Downloads
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

> **WSL/Linux path reminder:** use `./file.tgz`, not `.\file.tgz`.
>
> In Bash, `.\web-codex-orchestrator-0.3.3.tgz` is interpreted incorrectly and npm may try to open a file named `.web-codex-orchestrator-0.3.3.tgz`, producing an `ENOENT` error.

### Windows PowerShell

PowerShell uses the Windows-style relative path:

```powershell
cd $HOME\Downloads
npm install -g .\web-codex-orchestrator-0.3.3.tgz
```

So the rule is:

```text
WSL / Linux / macOS : ./web-codex-orchestrator-0.3.3.tgz
PowerShell          : .\web-codex-orchestrator-0.3.3.tgz
```

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

After WCO is installed, move into the repository that you actually want WCO to work on.

### WSL example

```bash
cd /mnt/d/Coding/my-project
wco
```

### PowerShell example

```powershell
cd D:\Coding\my-project
wco
```

Do not run WCO from the Downloads directory unless the Downloads directory itself is intentionally the project you want WCO to operate on.

## 5. First authorization

On the first interactive use, WCO delegates authorization to its **bundled official Codex runtime**.

The normal flow is:

```text
wco
 ↓
Codex official ChatGPT sign-in
 ↓
Browser authorization
 ↓
Return to the terminal
 ↓
WCO is ready
```

WCO does not ask a normal user to copy or enter:

- an OpenAI API key
- ChatGPT cookies
- a tunnel ID or runtime key
- a Cloudflare/ngrok endpoint
- a relay secret
- an MCP connector
- a custom domain

If the ChatGPT session later expires or is revoked, reconnect with:

```bash
wco web connect
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

| Mode | Start | Behavior |
| --- | --- | --- |
| **PAIR** | plain goal or `/new <goal>` | Interactive/default workflow for working with WCO on a task. |
| **AUTOPILOT** | `/auto <goal>` | Continues through bounded implementation, verification, review, and repair policy without routine intervention. |

Both modes preserve local mutation authority, deterministic verification, recovery, and the human-only merge/release boundary.

Neither mode automatically merges or releases your code.

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

## Daily use

After installation and the first successful ChatGPT authorization, the normal returning-user flow is intentionally small:

```bash
cd /path/to/project
wco
```

Then give WCO a goal.

You should not need to reinstall WCO, reconfigure a relay, or perform browser interaction for every task.

## Commands

Inside the interactive WCO CLI:

```text
/new <goal>             start a PAIR task
/auto <goal>            start an AUTOPILOT task
/mode                    show AUTOPILOT reviewer preference
/status                  show current progress
/task                    show current goal/contract state
/run                     continue the active workflow
/web status              show local ChatGPT/Codex readiness
/web connect             authorize or re-authorize ChatGPT
/web open                no-op in the normal local mode
/review                  show verification/review/result evidence
/pause                   stop before the next safe transition
/resume                  clear an explicit pause
/history                 show bounded local task history
/config                  show user-facing settings
/doctor                  show prerequisite diagnostics
/uninstall               remove WCO-owned local resources
/quit                    exit safely
```

Advanced compatibility profiles are explicit opt-ins only:

```text
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

### `wco: command not found`

First confirm that installation completed successfully:

```bash
npm list -g --depth=0
```

On WSL/Linux, also check whether the executable is visible on `PATH`:

```bash
command -v wco
npm prefix -g
```

On PowerShell:

```powershell
Get-Command wco
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

Run:

```bash
wco web connect
```

This repeats the official sign-in flow. WCO does not switch to an API-key or hosted-relay fallback.

### Not sure whether WCO is ready

Inside WCO, use:

```text
/doctor
/web status
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

## Context efficiency

WCO progressively narrows repository context instead of treating the entire repository as model authority:

```text
goal
→ summary / tree / search
→ focused exact file or region reads
→ digest reuse
→ contract
→ implementation and result deltas
```

Disposable caches or indexes may improve localization, but authoritative repository content resolves back to exact reads and digests before mutation.

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
