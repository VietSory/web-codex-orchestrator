# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Give ChatGPT Web a goal, let WCO own every exact mutation and verification step, and come back to a reviewed Draft PR. Only you ship it.**

Web Codex Orchestrator (WCO) is a local-first control plane for AI-assisted software engineering. ChatGPT Web supplies bounded semantic author/review decisions; WCO owns exact repository state, filesystem/Git mutation, deterministic verification, durable recovery, evidence and Draft-PR lifecycle.

## Normal user experience

After a human maintainer publishes a release to npm, installation is:

```bash
npm install -g web-codex-orchestrator
```

Then, for any registered Git repository:

```bash
cd /path/to/project
wco
```

On the first run only, WCO offers to open the **official OpenAI/ChatGPT configuration pages** needed to authorize the Web-native connection. Complete that one-time OpenAI/ChatGPT setup, return to WCO, and you are done.

Daily use is simply:

```bash
cd /path/to/project
wco
```

Then enter a normal-language goal:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

Or explicitly choose AUTOPILOT:

```text
/auto Fix the authentication race condition and add regression tests.
```

The normal user does **not** configure Cloudflare, ngrok, a VPS, a custom domain, DNS, AWS, a user-hosted OAuth server, a public localhost endpoint, relay secrets, manual ZIPs or run IDs.

## Web-native architecture

The default transport is `web_native_mcp`:

```text
WCO local
  |
  | local durable semantic state
  v
WCO MCP adapter
  ^
  | official openai/tunnel-client
  | outbound HTTPS only
  |
OpenAI Secure MCP Tunnel
  |
private WCO MCP app in ChatGPT
  |
private WCO Workspace Agent
  ^
  | official Workspace Agent trigger API
  |
WCO local
```

The trusted workstation is not exposed to public inbound traffic. WCO downloads only its pinned official `openai/tunnel-client` release, verifies the archive digest, starts/stops it itself, and keeps tunnel/Workspace-Agent credentials in owner-protected WCO storage outside repositories.

The WCO MCP surface is deliberately narrow. It can retrieve the pending task, inspect exact bounded Git-base context, and submit three kinds of semantic authority: task contract, bounded implementation proposal and review verdict. These semantic submit tools **cannot** edit repository files, execute shell/Git, verify code, publish, merge, deploy or release. The Harness remains the sole mutation authority.

### OpenAI capability boundary

The official OpenAI capabilities required by Web-native WCO are not available on every ChatGPT plan/workspace. If Secure MCP Tunnel, the required full MCP tools, or Workspace Agent API access is unavailable, WCO stops with `OPENAI_CAPABILITY_BLOCKED` (or a more specific Web-native diagnostic).

WCO does **not** silently fall back to Cloudflare, browser automation, public hosting or undocumented ChatGPT APIs. Optional compatibility transports still exist for advanced users, but they are never required by the normal install path.

## PAIR

PAIR is the default for a plain goal or `/new <goal>`:

```text
user goal
→ original ChatGPT Web (Web-A) inspects exact sealed repository/base
→ Web-A submits bounded implementation authority
→ WCO Harness validates/applies exact operations
→ deterministic network-disabled verification
→ independent Web code review (Web-B)
   ├─ APPROVE
   ├─ REVISE + bounded repair → Harness apply/re-verify → Web-B again
   └─ consequential boundary → NEEDS YOU
→ exact fast-forward publication
→ same open Draft PR + exact Result Bundle
→ original Web-A final intent review
   ├─ APPROVE
   ├─ REVISE + bounded repair → Harness apply/re-verify → same Draft PR → Web-A again
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human reviews/merges
```

PAIR creates **zero Codex/model-review calls**. It does not require Codex runtime/authentication. Harness model tokens remain zero.

## AUTOPILOT

AUTOPILOT starts only with `/auto <goal>`:

```text
user goal
→ original Web-A bounded implementation authority
→ Harness apply
→ deterministic verification
→ exactly ONE frozen Sol/Terra review pass by default
   ├─ APPROVE
   ├─ REVISE + complete bounded repair in that same model response
   │        → Harness apply/re-verify
   └─ consequential boundary → NEEDS YOU
→ same Draft PR + exact Result Bundle
→ original Web-A final intent review
   ├─ APPROVE
   ├─ REVISE + Web repair → Harness apply/re-verify → Web-A again
   │                         (no second Sol/Terra call)
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human reviews/merges
```

The default reviewer is `Sol · high`. Change the preference for **new** AUTOPILOT tasks with:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

PAIR ignores this preference. AUTOPILOT currently requires the pinned Codex runtime/authentication only for its selected Sol/Terra reviewer pass.

## First-run and daily commands

Normal commands:

```text
/new <goal>             start a new PAIR task
/auto <goal>            start an AUTOPILOT task
/mode                    show AUTOPILOT reviewer preference
/mode <model> <effort>   set reviewer preference for new AUTOPILOT tasks
/status                  show current progress
/task                    show current goal/contract state
/run                     continue the active workflow
/web status              show Web-native connection state
/web connect             one-time official OpenAI/ChatGPT Web-native setup
/web open                open official ChatGPT connector/developer settings
/web disconnect          remove local Web-native credential
/review                   show verification/review/result/Draft-PR evidence
/pause                   stop before the next safe transition
/resume                  clear an explicit pause
/history                 show bounded local task history
/config                  show user-facing settings
/config web              configure/reconnect Web-native transport
/doctor                  mode-aware prerequisite diagnostics
/uninstall               remove WCO-owned local resources
/unitsall                alias for /uninstall
/quit                    exit safely
```

WCO automatically resumes from durable local state after terminal/machine restart. Reopen the repository, run `wco`, inspect `/status`, then `/run` when needed. Ambiguous provider/model calls are not blindly replayed.

## Requirements

For PAIR:

- Linux or WSL;
- Node.js 22+ and npm;
- Git;
- Bubblewrap (`bwrap`) for deterministic network-disabled verification;
- GitHub authentication for Draft-PR delivery;
- an OpenAI/ChatGPT workspace with the official Web-native capabilities required above.

AUTOPILOT additionally requires authentication for WCO's pinned Codex reviewer runtime.

Use `/doctor` on an active task. It is transport- and mode-aware: PAIR never fails merely because Codex runtime/auth is unavailable, Web-native mode does not require a third-party relay or managed OAuth/device account, and AUTOPILOT checks only the reviewer prerequisites it actually uses.

## Security and authority boundary

WCO treats Web/model/repository/tool content as untrusted input and preserves these invariants:

- exact repository/base/tree/head and digest binding;
- bounded exact repository reads with sensitive-path denial;
- full exact read/preimage authority before replace/delete;
- strict closed semantic/mutation schemas;
- path traversal, symlink and TOCTOU protections;
- deterministic verification in Bubblewrap with network disabled and no unrestricted fallback;
- content-addressed disposable context cache that never creates authority;
- durable idempotent receipts around model/provider/network side effects;
- no blind replay after ambiguous provider calls;
- strict fast-forward same-Draft-PR publication, never force push;
- immutable prior result/review/publication generations;
- mandatory original-Web final review of the exact result;
- human-only merge, Mark Ready, release, tag, deployment and production publication boundaries.

## Context and token efficiency

WCO keeps repository context local and progressive:

```text
goal
→ compact exact repository map/search
→ ranked relevant paths/regions
→ bounded exact reads on demand
→ digest/cache references for unchanged content
→ diff/result deltas
```

It does not transmit the full repository or full historical transcript on every semantic turn. Harness and deterministic verification use zero model tokens.

## Advanced compatibility transports

These profiles are retained for explicit advanced/compatibility use only:

- `personal_actions`: Custom GPT Action + Bearer + RelayProtocol endpoint;
- `actions_relay`: legacy advanced self-hosted Bearer profile;
- `managed_actions`: organization/hosted OAuth + account/device profile;
- `manual_file`: offline/manual artifact compatibility.

The optional Cloudflare Worker under `web/personal-relay/` is only a reference adapter for users who deliberately choose `personal_actions`; it is not the default, not an installation requirement and not a Web-native release gate.

Browser DOM automation, ChatGPT cookie/session scraping, automatic UI-output extraction, undocumented ChatGPT endpoints and product/rate-limit bypass are not supported transports.

## Packaging and release

The package is prepared for the public npm name `web-codex-orchestrator`, but **publishing remains a human release action**. Repository automation and WCO itself must never run `npm publish`, tag a release, merge this project, or deploy production resources without the maintainer's explicit release decision.

Before a human release, maintainers qualify the exact candidate with:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Optional environment-backed qualification:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

After the human publishes the release to npm, end users use only:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

## Architecture and operations

See:

- [Architecture](docs/architecture.md)
- [Web bridge](docs/web-bridge.md)
- [ADR 0002 — official OpenAI Web-native default](docs/adr/0002-official-openai-web-native-default.md)
- [Job modes](docs/job-modes.md)
- [Operations](docs/operations.md)
- [Protocols](docs/protocols.md)
- [Security](SECURITY.md)

Advanced Task Bundle/Web-pack commands remain for deterministic automation and backward compatibility; normal users do not move ZIPs, copy run IDs, or invoke internal phase commands.