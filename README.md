# Web Codex Orchestrator

**Give WCO a software-engineering goal and come back to an exact reviewed Draft PR. Only you ship it.**

Web Codex Orchestrator (WCO) is a local-first CLI that keeps repository mutation, deterministic verification, recovery, task state, Git and Draft-PR authority on your machine.

For the normal **PAIR** path, ChatGPT Web authoring and review run through a WCO-owned Windows browser companion. PAIR does not require Codex provider authentication or Codex model quota.

## Quick start

The current first-party browser PAIR architecture is:

```text
WSL / WCO
  -> bounded JSONL stdin/stdout
  -> WCO-owned Windows companion
  -> loopback-only Chrome/Edge CDP
  -> real ChatGPT Temporary Chat
```

Repository reads, task authority, filesystem mutation, Bubblewrap verification, Git and publication stay in WSL. The Windows companion receives only prepared prompt text plus bounded model metadata. WSL never connects directly to browser CDP.

Normal PAIR setup therefore expects:

- Windows with **WSL** and Windows interop enabled;
- Node.js 22+ and npm inside WSL;
- Git;
- Bubblewrap (`bwrap`);
- Chrome or Edge on Windows;
- a ChatGPT account;
- GitHub CLI authentication when Draft-PR delivery is requested.

Native Windows is not the deterministic execution host. Native Linux can run WCO's Linux verification path, but the current first-party ChatGPT Web companion is Windows-native; use the explicit Codex provider on a host without Windows interop.

```text
Download WCO release
        ↓
Install the .tgz in WSL
        ↓
cd into YOUR project
        ↓
wco
        ↓
Sign in to ChatGPT in the WCO browser profile when needed
        ↓
Give WCO a goal
        ↓
Reviewed Draft PR
        ↓
You decide whether to merge
```

## Install

For release `v0.3.3`, download:

```text
web-codex-orchestrator-0.3.3.tgz
web-codex-orchestrator-0.3.3.tgz.sha256
```

A Draft-PR candidate is not a published release merely because its code or CI artifact exists on GitHub.

Verify the package from WSL/Linux:

```bash
sha256sum -c web-codex-orchestrator-0.3.3.tgz.sha256
```

Install it once inside WSL:

```bash
cd /mnt/c/Users/<windows-user>/Downloads
npm install -g ./web-codex-orchestrator-0.3.3.tgz
```

Then enter the repository WCO should work on:

```bash
cd /path/to/project
wco
```

Normal users do not clone WCO, run `npm ci`, or use GitHub's automatic source-code archives as the installed CLI package.

## First PAIR sign-in

Fresh setup defaults the owner-local provider preference to **`chatgpt-web`**. Trusted repository config intentionally has no `web_bridge` field; that absence is not permission to spend Codex quota.

For PAIR, WCO bootstraps its own Windows companion artifact, verifies its SHA-256, and uses a WCO-owned persistent browser profile. If ChatGPT sign-in is required, complete it in that WCO browser window.

WCO does **not** ask you to copy or enter:

- an OpenAI API key;
- ChatGPT cookies or tokens;
- your existing Chrome/Edge profile;
- a tunnel ID or runtime key;
- a Cloudflare/ngrok endpoint;
- an MCP connector;
- a relay secret or custom domain.

After sign-in, the companion opens a fresh **ChatGPT Temporary Chat** for each provider/reviewer turn. Per-task **manual** browser interactions = 0 in the normal healthy path.

Check readiness with:

```bash
wco web status
wco doctor --mode PAIR
```

`wco web connect` for the `chatgpt-web` provider is a readiness check/recovery command; it does not switch PAIR to Codex. If the companion/browser is unavailable, PAIR fails closed.

## PAIR vs AUTOPILOT

PAIR is the default collaborative mode:

```text
/new Add rate limiting to login and add regression tests
```

AUTOPILOT is explicit:

```text
/auto Add rate limiting to login and add regression tests
```

| Mode | Semantic author/review | Codex model quota |
| --- | --- | --- |
| **PAIR** | ChatGPT Web through WCO Windows companion | **not required** |
| **AUTOPILOT** | ChatGPT Web + one selected Sol/Terra adaptive review pass | required for that selected reviewer |

PAIR flow:

```text
user goal
→ ChatGPT Web author inspects bounded exact repository context
→ sealed contract + bounded implementation authority
→ Harness validates/applies exact operations
→ deterministic verification
→ independent ChatGPT Web code review
→ exact Draft PR / Result Bundle
→ original ChatGPT Web final intent review
→ READY_FOR_YOU
→ human review/merge
```

The ChatGPT Web companion never receives repository mutation, shell, Git, publish or merge authority. Provider output must pass WCO's closed schemas and exact identity/digest checks before workflow authority advances.

## Daily use

Returning-user PAIR should be only:

```bash
cd /path/to/project
wco
```

Then type a goal. No relay, endpoint, API key or Codex model selection is required for PAIR.

Important interactive commands:

```text
/new <goal>             start PAIR
/auto <goal>            start AUTOPILOT
/continue               continue the current unfinished saved task
/resume                  choose a saved task to resume
/status                  show progress and Your action
/task                    show current goal/plan state
/auth status             show provider readiness
/auth connect            retry provider readiness/sign-in
/review                  show verification/review/Draft-PR evidence
/pause                   pause at a safe boundary
/history                 inspect saved task history
/doctor                  check readiness
/config                   show current provider/reviewer configuration
/uninstall               remove WCO-owned local resources
/quit                    exit safely
```

`/run` remains a compatibility alias for `/continue`, but normal guidance teaches `/continue`.

## Provider choice

The default is `chatgpt-web`:

```bash
wco setup --provider chatgpt-web
```

An explicit Codex provider remains available:

```bash
wco setup --provider codex
```

Only an explicit persisted `codex` choice selects the Codex semantic provider. Missing preferences are treated as an upgrade/recovery state and do **not** authorize Codex spending.

Advanced `web_bridge` compatibility profiles (`web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, `manual_file`) remain opt-in only and are never a silent fallback from first-party browser PAIR.

## Local-first authority

For normal PAIR:

```text
WCO-hosted services                   = 0
third-party relay/cloud setup         = 0
public localhost/inbound ports        = 0
API/tunnel/relay keys entered         = 0
MCP/App/Workspace Agent setup         = 0
copied browser credentials            = 0
Codex provider turns                  = 0
per-task manual browser interactions  = 0
per-task authorization/config         = 0
automatic merge/release               = 0
```

The companion owns only its Windows browser process/profile and loopback-only CDP connection. WCO/WSL retains repository and shipment authority.

## Context and token efficiency

WCO progressively narrows exact repository context:

```text
goal
→ summary / tree / search
→ focused exact file or byte-region reads
→ digest reuse
→ sealed contract
→ implementation/result deltas
```

Authoritative context resolves back to exact Git/file bytes and SHA receipts before mutation. PAIR uses ChatGPT Web turns rather than Codex model turns; AUTOPILOT's selected reviewer remains separately bounded.

## Troubleshooting

### Browser companion is not ready

Run:

```bash
wco web status
wco doctor --mode PAIR
```

If prompted, finish ChatGPT sign-in in the WCO-owned Chrome/Edge profile. A missing helper, browser, setup path or session fails closed; WCO does not silently fall back to Codex.

### Native Windows says deterministic workflow requires WSL

That is intentional. Run the task workflow from WSL; the native Windows component is only the bounded browser companion.

### Native Linux without Windows interop

The current first-party browser companion is Windows-native. Use WSL for zero-Codex browser PAIR, or explicitly select the Codex provider on Linux if that is the desired transport.

### Unsupported Node.js version

```bash
node --version
```

WCO requires Node.js 22 or newer.

## For contributors

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run check
```

Useful gates include:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:user:contract
npm run pack:check
npm run pack:smoke
```

## Release boundary

Publishing WCO remains a human maintainer action. WCO must never merge this project, mark a PR ready, tag, deploy, release, or publish a package without an explicit maintainer decision.

The Windows companion release artifact is `wco-browser-companion-windows-x64.exe` with a matching `.sha256` sidecar. Release tag and package version must match, and existing companion assets are immutable under the release workflow.

A release is not normal-user ready until exact-head automated gates pass **and** a real signed-in Windows/WSL PAIR dogfood proves the first-party browser path, zero Codex provider turns, exact reviewed HEAD publication, and human-only merge/release.

## More documentation

- [Frozen user experience contract](docs/user-experience-contract.md)
- [Architecture](docs/architecture.md)
- [Web bridge](docs/web-bridge.md)
- [Job modes](docs/job-modes.md)
- [Operations](docs/operations.md)
- [Security policy](SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
