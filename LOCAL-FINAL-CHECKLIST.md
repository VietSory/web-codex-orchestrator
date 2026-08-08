# Local Final Checklist

Run this **only after** Phase 16 exact-head GitHub CI and both maintainer audits have passed. Run from the real WSL Bash environment you intend to use with WCO. Do not merge or mark any PR Ready first.

Return only the requested sanitized diagnostics. Never return API keys, cookies, authorization headers, OAuth/runtime tokens, browser-profile files, full private prompts/transcripts or private task content.

## 1. Exact checkout and native versions

```bash
git fetch origin
git switch codex/phase-16-final-hardening-v2
git pull --ff-only
git rev-parse HEAD
git status --short
node --version
npm --version
git --version
codex --version
uname -a
cmd.exe /c ver
npm ci
npm run build
```

Return:

- full `HEAD` SHA;
- complete `git status --short` output; it must be empty before testing;
- Node/npm/Git/Codex versions;
- `uname -a` and Windows `ver` output;
- `npm ci` and `npm run build` exit codes; if nonzero, include the failing error/stack.

## 2. Real native Codex sandbox integration

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration
```

Return:

- exit code and complete test summary;
- any bounded sandbox/auth/runtime diagnostic emitted by the test;
- no credentials or model transcript.

## 3. Real native Codex execution integration

```bash
WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration
```

Return:

- exit code and complete test summary;
- model/effort route if the test reports it;
- any bounded auth/session/reconnect/usage diagnostic;
- no credentials or full model transcript.

## 4. WCO doctor against the real run/config

Replace the three placeholders with the real values used for the native run:

```bash
node dist/orchestration/standalone-cli.js doctor \
  --run-id '<REAL_RUN_ID>' \
  --state-dir '<REAL_WCO_STATE_DIR>' \
  --config '<REAL_WCO_CONFIG_JSON>' \
  --json
```

Return the complete bounded JSON doctor report after removing secret **values** only. Keep diagnostic codes, versions and capability/status fields intact.

## 5. codex-chatgpt-web availability/health on this machine

First run exactly:

```bash
command -v codex-chatgpt-web || true
```

If it prints no executable path, return:

```text
BRIDGE_NOT_INSTALLED_OR_UNSUPPORTED
```

and stop this bridge section. Do **not** install an undocumented Windows/WSL workaround for the checklist; the current upstream README documents managed background installation as macOS-only.

If an executable path is returned, run exactly:

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web browser check
```

If `doctor` explicitly reports full/tunnel mode, also run:

```bash
codex-chatgpt-web tunnel status
```

Return the complete bounded outputs after removing secret values. Also return the installed bridge version if any of those commands reports it.

## 6. Sequential bridge turn/cleanup smoke — only if step 5 is ready

In native Codex, select the installed **ChatGPT Web** model route reported healthy by bridge `doctor`.

Start a fresh Codex task and send exactly:

```text
Reply exactly WCO_BRIDGE_SMOKE_1. Do not call tools.
```

After it completes, in the **same Codex task** send exactly:

```text
Reply exactly WCO_BRIDGE_SMOKE_2. Do not call tools.
```

Then run:

```bash
codex-chatgpt-web service status
codex-chatgpt-web browser check
```

Return:

- whether each response was exactly `WCO_BRIDGE_SMOKE_1` / `WCO_BRIDGE_SMOKE_2`;
- wall time for each turn measured locally;
- any disconnect/reconnect/cold-start/UI-drift message;
- final service/browser status showing whether the turn/session was released;
- no browser screenshots/profile or prompt transcript beyond the two fixed smoke strings.

## 7. Full-harness tool smoke — only if step 5 explicitly reports full mode with local tools

Use a ChatGPT Web route that bridge `doctor` reports as supporting local Codex tools; do not use a route it marks read-only/no-tool.

In a fresh Codex task send exactly:

```text
Use the local shell tool once to run: printf WCO_BRIDGE_TOOL_OK
Then reply exactly with the command output and nothing else.
```

Return:

- whether the tool call actually appeared in Codex's native tool UI;
- whether the final response was exactly `WCO_BRIDGE_TOOL_OK`;
- any approval/capability/namespace failure code;
- wall time;
- no unrelated shell/environment output.

## Return format

Return one message containing sections `LOCAL-1` through `LOCAL-7` with the requested outputs. For conditional bridge sections that did not run, return the exact reason (`BRIDGE_NOT_INSTALLED_OR_UNSUPPORTED`, `BRIDGE_NOT_READY`, or `BRIDGE_FULL_MODE_NOT_AVAILABLE`).
