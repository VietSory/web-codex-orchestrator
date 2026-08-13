# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Give ChatGPT Web a goal, let WCO own every exact mutation and verification step, and come back to a reviewed Draft PR. Only you ship it.**

Web Codex Orchestrator (WCO) is a local-first control plane for AI-assisted software engineering. ChatGPT Web supplies bounded semantic author/review decisions; WCO owns exact repository state, filesystem/Git mutation, deterministic verification, durable recovery, evidence and Draft-PR lifecycle.

## Normal user experience

After a human maintainer publishes a release to npm:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

### First run only

WCO opens **exactly one HTTPS authorization link** for the maintainer-operated WCO Web service. Authorize once and return to the terminal.

That is the complete normal Web setup. WCO never asks the normal user for a relay URL, GPT URL, tunnel ID, OpenAI/API key, Workspace Agent trigger ID, Workspace Agent token, schema, domain, cloud account or self-hosted service.

### Every run after authorization

```bash
cd /path/to/project
wco
```

Then type a goal:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

Or use AUTOPILOT explicitly:

```text
/auto Fix the authentication race condition and add regression tests.
```

Per-task browser interactions = **0**. WCO automatically starts the required Web author/review turns and stops at an exact reviewed Draft PR.

The normal user does **not** configure Cloudflare, ngrok, a VPS, custom domain/DNS, AWS, a user-hosted OAuth server, public localhost, relay secrets, Custom GPT Actions, MCP Apps, Workspace Agents, manual ZIPs or run IDs.

## Default Web architecture

The default transport is `managed_actions`:

```text
FIRST RUN

WCO local
  |
  | device id + nonce + PKCE S256
  v
maintainer-operated WCO Web service
  |
  | one verification_uri_complete
  v
browser → Authorize once
  |
  v
scoped refreshable WCO device credential

DAILY TASKS

user prompt
  |
  v
WCO managed relay/control plane
  |
  v
maintainer-configured ChatGPT Web / Workspace Agent
  |
  | bounded semantic contract / implementation / verdict
  v
WCO Harness
  |
  v
deterministic verification → same Draft PR → READY FOR YOU
```

The service owner provisions the hosted transport, ChatGPT OAuth/App/MCP/Workspace Agent integration and provider trigger credentials **once globally**. End users never copy those credentials.

Managed device credentials are scoped, stored outside repositories in owner-protected WCO storage and refreshed silently. Revocation may require the same one-link authorization again; it never turns into manual provider provisioning.

The managed semantic surface cannot edit files, run shell/Git, verify code, publish, merge, deploy or release. Harness remains the sole mutation/verification authority.

If the maintainer service is not fully provisioned, WCO fails with an operator/release diagnostic such as `WEB_MANAGED_OPERATOR_NOT_READY`. It does not tell the end user to deploy infrastructure or fall back to Cloudflare/native/manual setup.

## Automatic Web turns

Normal managed mode performs no per-task browser work:

```text
create authoring job
→ automatically trigger Web-A
→ Web-A submits bounded implementation authority
→ Harness apply + verify
→ automatically trigger independent Web-B when PAIR requires it
→ automatically resume original Web-A for final intent review
→ READY FOR YOU
```

The managed service must preserve original Web-A intent/conversation identity for final review and use an independent identity for Web-B.

## PAIR

PAIR is the default for a plain goal or `/new <goal>`:

```text
user goal
→ original ChatGPT Web (Web-A)
→ bounded implementation authority
→ WCO Harness validates/applies exact operations
→ deterministic network-disabled verification
→ independent Web-B code review
   ├─ APPROVE
   ├─ REVISE + bounded repair → Harness apply/re-verify → Web-B again
   └─ consequential boundary → NEEDS YOU
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

The default reviewer is `Sol · high`. Change the preference for new AUTOPILOT tasks with:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

PAIR ignores this preference. AUTOPILOT currently requires the pinned Codex runtime/authentication only for its selected Sol/Terra reviewer pass.

## Commands

```text
/new <goal>             start a PAIR task
/auto <goal>            start an AUTOPILOT task
/mode                    show AUTOPILOT reviewer preference
/mode <model> <effort>   set reviewer preference for new AUTOPILOT tasks
/status                  show current progress
/task                    show current goal/contract state
/run                     continue the active workflow
/web status              show managed Web connection state
/web connect             normal one-link authorization/reauthorization
/web disconnect          revoke/remove local managed authorization
/review                   show verification/review/result/Draft-PR evidence
/pause                   stop before the next safe transition
/resume                  clear an explicit pause
/history                 show bounded local task history
/config                  show user-facing settings
/doctor                  mode-aware prerequisite diagnostics
/uninstall               remove WCO-owned local resources
/quit                    exit safely
```

Advanced only:

```text
wco web connect --native       explicit Secure MCP Tunnel/operator profile
wco web setup --personal       explicit personal Action/relay profile
wco web connect --self-hosted  explicit legacy self-hosted relay profile
```

WCO never auto-falls back to an advanced profile.

## Requirements

For normal PAIR:

- Linux or WSL;
- Node.js 22+ and npm;
- Git;
- Bubblewrap (`bwrap`) for deterministic network-disabled verification;
- GitHub authentication for Draft-PR delivery;
- the maintainer-operated WCO Web service shipped for that release.

AUTOPILOT additionally requires authentication for WCO's pinned Codex reviewer runtime.

End users do not deploy the WCO Web service. Service deployment and ChatGPT/Agent provisioning are maintainer release prerequisites.

## Advanced official Secure MCP Tunnel profile

`web_native_mcp` remains available for advanced/operator use through `wco web connect --native`. It is not the default because the provider's current setup exposes developer/operator controls such as tunnel IDs, runtime keys, MCP/App configuration and Workspace Agent credentials. Those steps are explicitly forbidden from the normal-user path.

The advanced native path remains outbound-only and narrow: it still does not receive local mutation authority.

## Security and authority boundary

WCO treats Web/model/repository/tool content as untrusted input and preserves:

- exact repository/base/tree/head and digest binding;
- bounded exact repository reads with sensitive-path denial;
- full exact read/preimage authority before replace/delete;
- strict closed semantic/mutation schemas;
- path traversal, symlink and TOCTOU protections;
- deterministic verification in Bubblewrap with network disabled and no unrestricted fallback;
- content-addressed disposable context cache that never creates authority;
- durable idempotent receipts around provider/network side effects;
- no blind replay after ambiguous provider calls;
- strict fast-forward same-Draft-PR publication, never force push;
- immutable prior result/review/publication generations;
- mandatory original-Web final review of the exact result;
- human-only merge, Mark Ready, release, tag, deployment and production publication boundaries.

## Context and token efficiency

```text
goal
→ compact exact repository map/search
→ ranked relevant paths/regions
→ bounded exact reads on demand
→ digest/cache references for unchanged content
→ diff/result deltas
```

WCO does not transmit the full repository or full historical transcript on every semantic turn. Harness and deterministic verification use zero model tokens.

## Advanced compatibility transports

These profiles are retained only for explicit advanced use:

- `web_native_mcp`: official Secure MCP Tunnel / local MCP operator profile;
- `personal_actions`: Custom GPT Action + Bearer + RelayProtocol endpoint;
- `actions_relay`: legacy advanced self-hosted Bearer profile;
- `manual_file`: offline/manual artifact compatibility.

The optional Cloudflare Worker under `web/personal-relay/` is only a reference adapter for an advanced user who deliberately selects `personal_actions`. It is never a normal installation or release requirement.

Browser DOM automation, ChatGPT cookie/session scraping, automatic UI-output extraction, undocumented ChatGPT endpoints and product/rate-limit bypass are not supported transports.

## Packaging and release

Publishing remains a human maintainer action. WCO/repository automation must never merge this project, Mark Ready, tag, deploy production resources or run `npm publish` without the maintainer's explicit release decision.

Before release:

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

A release is not normal-user ready until live acceptance proves exactly one first-run authorization URL, zero manual endpoint/credential inputs and zero per-task browser interaction.

## Architecture and operations

See:

- [Frozen user experience contract](docs/user-experience-contract.md)
- [Architecture](docs/architecture.md)
- [Web bridge](docs/web-bridge.md)
- [ADR 0003 — one-link managed default](docs/adr/0003-one-link-managed-default.md)
- [Job modes](docs/job-modes.md)
- [Operations](docs/operations.md)
- [Protocols](docs/protocols.md)
- [Security](SECURITY.md)

Advanced Task Bundle/Web-pack commands remain for deterministic automation and backward compatibility; normal users do not move ZIPs, copy run IDs or invoke internal phase commands.