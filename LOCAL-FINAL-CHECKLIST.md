# Local final checklist

Run these from the repository root in WSL, except the first command which is PowerShell. Return the complete output for every command that is not an exact PASS.

```powershell
wsl.exe --status
```

```bash
node --version
npm --version
git --version
codex --version
codex login status
npm ci
npm run typecheck
npm test
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 WCO_KEEP_FAILED_INTEGRATION=1 npm run test:native:codex
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web browser check
```

If `test:native:codex` fails, also return every printed `WCO_FAILED_INTEGRATION_ROOT=` and `WCO_FAILED_INTEGRATION_STATE=` line. Do not send browser-profile files, tokens, cookies, credentials, or anything under `~/.codex-chatgpt-web/browser`.
