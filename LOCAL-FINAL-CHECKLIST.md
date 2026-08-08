# LOCAL FINAL CHECKLIST

Run only these checks. Return the requested outputs; redact credentials/tokens and do not send raw Codex/ChatGPT transcripts or private task contents.

## 1. Windows host

From PowerShell:

```powershell
wsl.exe --status
wsl.exe --version
codex --version
```

Return: complete output and exit code for each command. If `codex` is intentionally WSL-only, return the exact PowerShell `codex --version` failure instead of installing/changing anything.

## 2. WSL checkout and final gate

From the Phase 16 checkout in WSL:

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm --version
git --version
codex --version
npm ci
npm run phase16:release-gate
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration
WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration
```

Return: all version/head/status lines, PASS output for the three test commands, or the complete failing command/output plus exit code.

## 3. Prepared-run control-plane smoke

Set the real local values, then run:

```bash
export RUN_ID='<task-id>:<task-bundle-sha256>'
export WCO_STATE='<absolute-state-directory>'
export WCO_CONFIG='<absolute-config-json>'
npm run build
npm run doctor -- --state-dir "$WCO_STATE" --config "$WCO_CONFIG" --json
npm run control -- status --run-id "$RUN_ID" --state-dir "$WCO_STATE" --json
```

`doctor` intentionally does not require a run ID: it is the machine/runtime/config preflight that should also work before the first task exists. `status` remains run-specific.

Return: both complete JSON outputs, with secrets/private paths redacted if necessary.

## 4. `codex-chatgpt-web` native capability/session smoke

First run exactly:

```bash
command -v codex-chatgpt-web || true
codex-chatgpt-web --version
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web browser check
```

If `doctor` reports full/tunnel mode, also run:

```bash
codex-chatgpt-web tunnel status
```

If `codex-chatgpt-web` is not installed/supported on this Windows/WSL deployment, stop this section and return the exact `command -v`, version, and/or doctor failure; do not install or reconfigure it just for this checklist.

If the bridge is ready, run a bounded fresh/resume test from this WCO checkout:

```bash
codex
```

In Codex, select an available `ChatGPT Web — …` model, send exactly `Reply exactly WCO-BRIDGE-FRESH-PASS and do not modify files.`, confirm the reply, then exit. Next run:

```bash
codex resume
```

Select the just-created session for this checkout, send exactly `Reply exactly WCO-BRIDGE-RESUME-PASS and do not modify files.`, confirm the reply, then exit.

Return only: bridge version, Codex version, doctor/service/browser/tunnel status, selected bridge mode/model label, advertised transport/tool/capability names, active/queued counts if reported, fresh/resume PASS or FAIL, elapsed time for each turn, exit codes, and sanitized errors. Do not return transcript text, browser profile data, credentials, or tokens.
