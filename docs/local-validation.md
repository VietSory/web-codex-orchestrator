# Local validation

Use this checklist only after deterministic CI is green for the exact candidate head. Native checks exercise host-specific WSL, Git, sandbox, Codex authentication, and provider integration that GitHub CI intentionally cannot emulate.

## Environment preflight

From PowerShell:

```powershell
wsl.exe --status
```

Then run the remaining commands from the repository root inside WSL:

```bash
node --version
npm --version
git --version
codex --version
codex login status
```

WCO requires Node.js 22 or newer. The project itself uses the pinned bundled Codex runtime; the global `codex` checks above confirm that the local user authentication/runtime environment is available for native integration.

## Deterministic local gate

```bash
npm ci
npm run validate:template
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run test:cli
npm run pack:check
```

Every command above must pass before native provider-backed testing.

## Native sandbox and Codex gates

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 WCO_KEEP_FAILED_INTEGRATION=1 npm run test:native:codex
```

The native Codex integration can create provider-backed turns. Keep the failed integration fixture only for diagnosis; successful fixtures are cleaned automatically.

If `test:native:codex` fails, preserve the ordinary test output and the printed `WCO_FAILED_INTEGRATION_ROOT=` / `WCO_FAILED_INTEGRATION_STATE=` paths. Do not share tokens, cookies, credential files, `~/.codex`, or browser-profile data.

## Optional Web bridge diagnostics

If `codex-chatgpt-web` is installed as part of the local Web transport environment, these checks are useful but are not WCO lifecycle authority:

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web browser check
```

Never share files from `~/.codex-chatgpt-web/browser`.

## Native context A/B benchmark

The v0.2 context benchmark is intentionally opt-in and provider-backed. Run it only against an exact `READY_FOR_PUBLISH` executor snapshot after the normal native gates pass. The benchmark must compare the same exact change-set digest with fresh read-only reviewer turns and report provider token usage, latency, and exact-digest approval rate. Offline context-path-byte measurements are not token-cost claims.
