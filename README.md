# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Give WCO a software-engineering goal and come back to an exact reviewed Draft PR. Only you ship it.**

WCO is a local-first orchestrator. Repository/worktree state, task state, receipts, mutation authority, verification, recovery and Git lifecycle remain on the user's machine.

## Normal user experience

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

On the first interactive use, WCO delegates one official ChatGPT browser authorization to its bundled pinned Codex runtime. After that, daily use is just `wco` and a goal.

A fresh normal-user config intentionally has **no `web_bridge` field**. Absence selects the zero-config local ChatGPT/Codex transport. Per-task browser interactions = **0**.

WCO does not require a normal user to deploy a WCO server, relay, cloud service, public endpoint or connector. An expired provider session is recovered with `wco web connect`, which repeats the official sign-in flow instead of silently changing transport.

## Architecture

```text
user goal
  -> semantic author (read-only)
  -> bounded exact repository reads
  -> sealed contract
  -> canonical prepared run
  -> Harness-side Codex implementation proposal
  -> WCO validation + isolated mutation
  -> deterministic verification / repair
  -> exact result evidence
  -> independent semantic final review
  -> reviewed Draft PR
  -> human merge / release
```

Provider/model output is never direct repository or shipment authority. WCO validates closed schemas plus exact job/run/path/digest bindings before workflow authority can advance.

## Context efficiency

Authoring is progressive:

```text
goal
→ summary / tree / search
→ focused exact file or region reads
→ digest reuse
→ contract
→ implementation and result deltas
```

Disposable caches or local indexes may improve localization, but authoritative repository content must resolve back to exact reads and digests before mutation.

## PAIR and AUTOPILOT

PAIR is the default for a plain goal or `/new <goal>`. AUTOPILOT starts with `/auto <goal>` and continues through bounded review/repair policy without routine intervention.

Both modes preserve local mutation authority, verification, recovery and the human-only shipment boundary. Neither mode merges or releases automatically.

## Commands

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

Advanced compatibility profiles remain explicit only:

```text
wco web connect --native
wco web connect --managed
wco web setup --personal
wco web connect --self-hosted
```

WCO never auto-falls back to an advanced profile.

## Requirements

- Node.js 22+ and npm
- Git
- platform sandbox prerequisites for the selected execution mode
- one ChatGPT authorization through bundled Codex
- GitHub authentication only when Draft-PR delivery is requested

## Release boundary

Publishing remains a human maintainer action. WCO must never merge this project, Mark Ready, tag, deploy, release or publish a package without an explicit maintainer decision.

Before release:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:contract
```

A release is not normal-user ready until the exact packaged zero-config journey passes and a real local acceptance confirms first authorization, complete goal-to-Draft-PR execution, final review and restart/recovery behavior.

## More

- [Frozen user experience contract](docs/user-experience-contract.md)
- [Architecture](docs/architecture.md)
- [Web bridge](docs/web-bridge.md)
- [ADR 0004 — local ChatGPT/Codex default](docs/adr/0004-chatgpt-codex-local-default.md)
- [Job modes](docs/job-modes.md)
- [Operations](docs/operations.md)